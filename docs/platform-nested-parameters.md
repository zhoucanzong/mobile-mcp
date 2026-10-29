下列字段的结构由 `src/automation.ts`、`src/harmony-gestures.ts` 和 `src/server.ts` 定义。if/repeat 的子列表递归使用相同节点规则，最多三层；没有用省略嵌套字段的方式声称参数已对齐。

| 所属结构 | 字段 | 三平台共用语义与鸿蒙差异 |
|---|---|---|
| condition | kind | element / app / orientation；使用对应 Robot 读取，不执行操作 |
| element condition | selector, state | state=present/absent，默认present；读取失败报错，不解释成absent |
| selector | identifier, text, label, type | 至少一项；全部给出的项同时满足；Unicode原样匹配，无OCR；实际字段依赖设备树 |
| selector | match | exact默认；contains只作用text/label，identifier/type保持精确 |
| selector | enabled, selected, checked | 可选布尔值，未报告状态不能等于false；target拒绝明确禁用元素 |
| app condition | packageName | 与实际前台包名精确比较；不能使用鸿蒙bundle/Ability组合代替包名 |
| orientation condition | orientation | portrait / landscape，后端读到的方向须一致 |
| gesture node | kind | tap / hold / drag / pinch / pause；仅鸿蒙支持新的组合手势工具 |
| point / from / to / center | x, y | 非负整数，原屏幕像素；转换结果须在屏幕内，输入上限2147483647 |
| tap / hold | point | 点击或长按位置；没有ref字段 |
| hold | durationMs | 1–10000，默认500；明确使用自定义时长uinput |
| pause | durationMs | 1–5000，不发设备输入 |
| drag / pinch | 其余字段 | 与独立拖拽/缩放工具的同名参数一致，见上表 |
| batch step | name, arguments | 复用工具参数；arguments可覆盖device；不支持嵌套batch/inline图片 |
| workflow call | kind, name, arguments | kind=call；只允许明确列出的工具；arguments沿用工具schema，禁止覆盖device及嵌套workflow/batch/云/会话工具 |
| workflow call | target | 可选selector，仅点击/双击/长按可用；与ref/x/y互斥；唯一匹配且有新ref才操作 |
| workflow call | expect, verifyTimeoutMs | 操作后检查condition，等待0–60000ms默认10000；检查失败可使已执行操作的步骤失败 |
| workflow call | attempts, retryDelayMs | 1–3默认1；显式重试整个动作及检查；间隔0–5000默认250；可能重复副作用，无回滚 |
| workflow wait | kind, condition, timeoutMs, pollIntervalMs, stableForMs | kind=wait，时间规则同等待工具；不接受device/captureOnFailure |
| workflow if | kind, condition, then, else | kind=if；立即检查，then非空，else可空且默认[]；只运行一个分支 |
| workflow repeat | kind, steps, maxIterations, until | kind=repeat；1–50次；until可选，循环前后都检查，已满足则0轮，上限仍不满足报错 |

源代码检查能证明当前分支的分流、传参、校验和本地算法；对外部 mobilecli 及手机的实际平台行为，仍须各自的设备测试。系统级定位、录屏授权、模拟器、云服务不能通过增加相同工具名补齐。

可选遥测工具 `get_more_tools` 只有一个必填字符串参数 `context`，三平台完全共用反馈路径；不下载工具、不增加鸿蒙能力，也不操作设备。`MOBILEMCP_DISABLE_TELEMETRY` 非空时不注册。其 context 会按既有行为发送给维护者，不应包含私密信息；审计生成器关闭遥测且不调用此工具。
