"""模型密钥核验的单元测试（离线，不打网络）。

守住三件事：
1) 分类正确：401/403 才算「密钥失效」，端点不支持 /models 或网络不通只能算「未核验」
   —— 把不确定当失败会让控制台误报，把失败当成功就是本次要修的 bug。
2) 缓存按「指纹」失效：Key 或地址一改，旧结论必须作废。
3) 只有「确证失效」的模型才进 dead_ids（路由器据此跳过）。
"""

from __future__ import annotations

import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import model_health  # noqa: E402


def _model(mid="deepseek", key="sk-test", base="https://api.example.com/v1", access="api"):
    return {"id": mid, "apiKey": key, "baseURL": base, "access": access}


class ClassifyTest(unittest.TestCase):
    def test_200_is_ok(self):
        self.assertEqual(model_health.classify(200)[0], "ok")

    def test_401_403_are_auth(self):
        self.assertEqual(model_health.classify(401)[0], "auth")
        self.assertEqual(model_health.classify(403)[0], "auth")

    def test_missing_endpoint_is_unknown_not_failure(self):
        # 端点不提供 /models 只能说明「核验不了」，不能报成密钥失效
        for code in (404, 405, 501):
            self.assertEqual(model_health.classify(code)[0], "unknown")

    def test_network_error_is_unknown(self):
        self.assertEqual(model_health.classify(0, "URLError: timeout")[0], "unknown")

    def test_server_error_is_error(self):
        self.assertEqual(model_health.classify(500)[0], "error")
        self.assertEqual(model_health.classify(503)[0], "error")


class ProbeUrlTest(unittest.TestCase):
    def test_appends_models_without_doubling_slash(self):
        self.assertEqual(model_health.probe_url("https://a.b/v1/"), "https://a.b/v1/models")
        self.assertEqual(model_health.probe_url("https://a.b"), "https://a.b/models")


class ProbeTest(unittest.TestCase):
    def test_local_is_not_probed(self):
        # 本地模型进程可能没起，核验会误报 → 一律 local
        self.assertEqual(model_health.probe(_model(access="local"))["state"], "local")

    def test_missing_key(self):
        self.assertEqual(model_health.probe(_model(key=""))["state"], "missing")

    def test_invalid_base_url(self):
        self.assertEqual(model_health.probe(_model(base="not-a-url"))["state"], "unknown")

    def test_http_error_maps_to_state(self):
        import urllib.error
        err = urllib.error.HTTPError("https://a.b/models", 401, "Unauthorized", {}, None)
        with mock.patch.object(model_health.urllib.request, "urlopen", side_effect=err):
            out = model_health.probe(_model())
        self.assertEqual(out["state"], "auth")
        self.assertEqual(out["http"], 401)


class FingerprintTest(unittest.TestCase):
    def test_changes_with_key_or_base(self):
        a = model_health.fingerprint(_model())
        self.assertNotEqual(a, model_health.fingerprint(_model(key="sk-other")))
        self.assertNotEqual(a, model_health.fingerprint(_model(base="https://other.example/v1")))

    def test_stable_for_same_input(self):
        self.assertEqual(model_health.fingerprint(_model()), model_health.fingerprint(_model()))


class StatesForTest(unittest.TestCase):
    def test_no_cache_is_pending_not_ok(self):
        states = model_health.states_for({"models": {}}, [_model()])
        self.assertEqual(states["deepseek"]["state"], "pending")
        self.assertFalse(states["deepseek"]["verified"])

    def test_fresh_cache_is_verified(self):
        m = _model()
        cache = {"models": {"deepseek": {
            "state": "auth", "http": 401, "message": "x",
            "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "fingerprint": model_health.fingerprint(m),
        }}}
        st = model_health.states_for(cache, [m])["deepseek"]
        self.assertEqual(st["state"], "auth")
        self.assertTrue(st["verified"])

    def test_key_change_invalidates_cache(self):
        m = _model()
        cache = {"models": {"deepseek": {
            "state": "ok", "http": 200, "message": "x",
            "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "fingerprint": model_health.fingerprint(m),
        }}}
        # 换了 Key：旧结论必须作废，回到 pending 等重测
        st = model_health.states_for(cache, [_model(key="sk-new")])["deepseek"]
        self.assertEqual(st["state"], "pending")

    def test_local_and_missing_short_circuit(self):
        states = model_health.states_for({"models": {}}, [_model(access="local"), _model("x", key="")])
        self.assertEqual(states["deepseek"]["state"], "local")
        self.assertEqual(states["x"]["state"], "missing")


class RefreshTest(unittest.TestCase):
    def test_probes_only_stale_and_records_fingerprint(self):
        m = _model()
        with mock.patch.object(model_health, "probe",
                               return_value={"state": "ok", "http": 200, "message": "鉴权通过",
                                             "checkedAt": "2026-10-04T10:00:00"}) as p:
            out = model_health.refresh({"models": {}}, [m])
        self.assertEqual(p.call_count, 1)
        self.assertEqual(out["models"]["deepseek"]["state"], "ok")
        self.assertEqual(out["models"]["deepseek"]["fingerprint"], model_health.fingerprint(m))

    def test_fresh_entry_is_not_reprobed(self):
        m = _model()
        cache = {"models": {"deepseek": {
            "state": "ok", "http": 200, "message": "x",
            "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "fingerprint": model_health.fingerprint(m),
        }}}
        with mock.patch.object(model_health, "probe") as p:
            model_health.refresh(cache, [m])
        p.assert_not_called()

    def test_local_never_probed(self):
        with mock.patch.object(model_health, "probe") as p:
            out = model_health.refresh({"models": {}}, [_model(access="local")])
        p.assert_not_called()
        self.assertEqual(out["models"], {})

    def test_force_reprobes(self):
        m = _model()
        cache = {"models": {"deepseek": {
            "state": "ok", "http": 200, "message": "x",
            "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "fingerprint": model_health.fingerprint(m),
        }}}
        with mock.patch.object(model_health, "probe",
                               return_value={"state": "auth", "http": 401, "message": "密钥无效或已过期",
                                             "checkedAt": "2026-10-04T10:00:00"}) as p:
            out = model_health.refresh(cache, [m], force=True)
        p.assert_called_once()
        self.assertEqual(out["models"]["deepseek"]["state"], "auth")


class DeadAndSharedTest(unittest.TestCase):
    def _cache(self, state, m):
        return {"models": {"deepseek": {
            "state": state, "http": 0, "message": "",
            "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "fingerprint": model_health.fingerprint(m),
        }}}

    def test_only_verified_auth_is_dead(self):
        m = _model()
        self.assertEqual(model_health.dead_ids(self._cache("auth", m), [m]), ["deepseek"])
        # 未核验 / 网络异常不算「确证失效」，不能把用户模型踢出去
        self.assertEqual(model_health.dead_ids(self._cache("unknown", m), [m]), [])
        self.assertEqual(model_health.dead_ids({"models": {}}, [m]), [])

    def test_shared_payload_shape(self):
        m = _model()
        payload = model_health.shared_payload(self._cache("auth", m), [m])
        self.assertEqual(payload["unhealthy"], ["deepseek"])
        self.assertEqual(payload["states"]["deepseek"], "auth")


class CacheIoTest(unittest.TestCase):
    def test_roundtrip_and_permissions(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "model-health.json"
            model_health.save_cache(p, {"version": 1, "updatedAt": "x", "models": {"a": {"state": "ok"}}})
            self.assertEqual(model_health.load_cache(p)["models"]["a"]["state"], "ok")
            self.assertEqual(os.stat(p).st_mode & 0o777, 0o600)
            # 原子写不留下临时文件
            self.assertFalse(p.with_suffix(p.suffix + ".tmp").exists())

    def test_broken_json_falls_back_to_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "model-health.json"
            p.write_text("{not json", encoding="utf-8")
            self.assertEqual(model_health.load_cache(p)["models"], {})

    def test_drop_removes_entry(self):
        m = _model()
        cache = {"version": 1, "models": {"deepseek": {"state": "auth"}, "zhipu": {"state": "ok"}}}
        out = model_health.drop(cache, "deepseek")
        self.assertNotIn("deepseek", out["models"])
        self.assertIn("zhipu", out["models"])
        # 原对象不被就地修改（调用方可能还要用）
        self.assertIn("deepseek", cache["models"])
        del m


if __name__ == "__main__":
    unittest.main()
