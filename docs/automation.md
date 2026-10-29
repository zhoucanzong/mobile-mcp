# 手势扩展与可验证流程

本分支新增六个 MCP 工具，覆盖拖拽、双指缩放、组合手势、等待、结果检查和条件循环。源码和模拟协议测试属于第一阶段；Mate 60 Pro / 鸿蒙 7 的设备命令、应用响应及中文输入仍统一留到第二阶段实测。没有在 npm 上发布这些扩展。

## 新工具

| 工具 | 用途 | 平台与边界 |
|---|---|---|
| `mobile_drag_on_screen` | 按住起点后拖到终点 | 鸿蒙 uinput；总时长包含按住时间 |
| `mobile_pinch_on_screen` | 两根手指同时向中心收缩或向外展开 | 鸿蒙 uinput 多指触屏输入；不是两次顺序滑动 |
| `mobile_perform_gestures` | 顺序组合 tap、hold、drag、pinch、pause | 鸿蒙；相邻手势之间抬起手指，不是连续任意多指轨迹 |
| `mobile_wait_for_condition` | 等待元素出现/消失、前台应用或屏幕方向 | 使用后端提供的界面、前台应用及方向能力 |
| `mobile_assert_condition` | 立即检查上述条件 | 不匹配返回 MCP 错误，不会把命令返回成功当作业务成功 |
| `mobile_run_workflow` | 条件分支、循环、等待、操作后检查和显式重试 | 同一设备，最多三层控制结构；使用下列明确允许的操作 |

六个工具均支持 `captureOnFailure`，默认 `true`。失败时尝试把截图、设备日志和错误记录保存在 MCP 服务器的私有临时目录，并返回路径。参数格式在 MCP 校验阶段被拒绝、或设备尚不能建立连接时，无法进入设备取证。取证不会改变原来的失败结论。

## 手势参数

坐标使用原始屏幕像素整数，不能使用缩放预览图的坐标。执行前验证坐标和设备命令能力；越界时报错，不偷偷截断坐标。组合手势会先检查全部参数和初始屏幕边界，每一步执行前再检查当前屏幕边界，任意一步失败即停止。此前步骤可能已经生效，不回滚。

拖拽示例：

```json
{
  "device": "harmony:YOUR_DEVICE",
  "from": { "x": 200, "y": 600 },
  "to": { "x": 700, "y": 600 },
  "pressMs": 600,
  "durationMs": 1500
}
```

调用 `mobile_drag_on_screen`。`pressMs` 默认 500，范围 500–14500；`durationMs` 默认 1000，范围 1000–15000，且必须比 `pressMs` 至少多 500 毫秒。

双指缩放示例：

```json
{
  "device": "harmony:YOUR_DEVICE",
  "center": { "x": 500, "y": 800 },
  "startDistance": 100,
  "endDistance": 400,
  "angle": 0,
  "durationMs": 600
}
```

调用 `mobile_pinch_on_screen`。距离表示两根手指的完整间距，范围 2–10000 像素，起止间距必须不同；最终坐标仍须位于屏幕内。终止间距更大表示向外展开，应用是否缩放取决于当前控件。`angle` 为相对屏幕水平轴的角度（-180–180，默认 0）；90 表示竖直排列。时长 1–15000 毫秒，默认 500。

组合调用 `mobile_perform_gestures`：

```json
{
  "device": "harmony:YOUR_DEVICE",
  "gestures": [
    { "kind": "tap", "point": { "x": 500, "y": 500 } },
    { "kind": "pause", "durationMs": 300 },
    { "kind": "hold", "point": { "x": 500, "y": 500 }, "durationMs": 700 },
    { "kind": "pinch", "center": { "x": 500, "y": 800 }, "startDistance": 100, "endDistance": 300 },
    { "kind": "drag", "from": { "x": 200, "y": 600 }, "to": { "x": 700, "y": 600 } }
  ]
}
```

最多 20 步，请求的时长合计最多 60 秒，不包含截图、命令检查和传输开销。`pause` 1–5000 毫秒，`hold` 1–10000 毫秒（默认 500）。命令中断后不声称触摸已经释放；特别是双指输入，系统 CLI 没有按 pointer ID 取消的接口，需要检查设备触摸状态后再重试。

实现依据是 OpenHarmony [uinput 官方源码](https://github.com/openharmony/multimodalinput_input/blob/7f674c11dee34d4c158827ca8f0e8db3b12a1d4b/tools/inject_event/src/input_manager_command.cpp)的触屏拖拽和多指移动参数。执行时检查目标设备帮助输出、退出状态及参数回显；这些证据只说明输入命令执行完成，不证明应用接收了手势，应用结果应通过 `expect` 或单独的条件检查确认。商业鸿蒙可能没有这些命令或权限。

## 等待与结果检查

`mobile_wait_for_condition` 示例：

```json
{
  "device": "harmony:YOUR_DEVICE",
  "condition": {
    "kind": "element",
    "selector": { "text": "登录成功", "match": "contains" },
    "state": "present"
  },
  "timeoutMs": 10000,
  "pollIntervalMs": 250,
  "stableForMs": 500
}
```

- `selector` 至少包含 identifier、text、label、type 之一；所有给出的条件同时满足。可追加 enabled、selected、checked 布尔状态。未知状态不会被当成 `false`。
- 默认精确匹配，保留中文、Emoji 和空格，不做大小写或 Unicode 归一化。`match: "contains"` 只影响 text、label，identifier 和 type 始终精确匹配。不支持正则表达式。
- `state: "absent"` 表示本次界面树中没有匹配元素。设备断开、读取失败或权限错误会直接报错，不会误判成元素消失。界面树没有提供的内容仍需截图检查；present 不证明元素未被遮挡。
- 条件也可以是 `{"kind":"app","packageName":"com.example.app"}` 或 `{"kind":"orientation","orientation":"landscape"}`。
- 等待默认 10 秒，范围 0–60000 毫秒；0 表示只检查一次。轮询间隔 50–5000 毫秒。`stableForMs` 默认 0、最大 10000、不能超过 timeoutMs，要求连续观测匹配；不能证明两次观测之间界面从未变化。
- 成功返回实际观察及匹配元素的最新引用。每次重新读取界面都会更新鸿蒙引用。

立即检查使用 `mobile_assert_condition`，传入同样的 device、condition；不接受等待参数。不满足时 `isError: true`。已有基础工具仍保持原返回语义；需要业务检查时，使用此工具或以下流程的 `expect`。

## 条件、循环与重试

`mobile_run_workflow` 示例：先等待输入框，按中文标签定位，再输入文字并确认结果；可选地关闭弹窗，最后最多滑动三次寻找目标。

```json
{
  "device": "harmony:YOUR_DEVICE",
  "timeoutMs": 60000,
  "maxSteps": 30,
  "steps": [
    { "kind": "wait", "condition": { "kind": "element", "selector": { "identifier": "search_input" } } },
    { "kind": "call", "name": "mobile_click_on_screen_at_coordinates", "target": { "identifier": "search_input" } },
    {
      "kind": "call",
      "name": "mobile_type_keys",
      "arguments": { "text": "鸿蒙测试", "submit": false },
      "expect": { "kind": "element", "selector": { "identifier": "search_input", "text": "鸿蒙测试" } },
      "verifyTimeoutMs": 3000
    },
    {
      "kind": "if",
      "condition": { "kind": "element", "selector": { "text": "稍后再说" } },
      "then": [{ "kind": "call", "name": "mobile_click_on_screen_at_coordinates", "target": { "text": "稍后再说" } }],
      "else": []
    },
    {
      "kind": "repeat",
      "maxIterations": 3,
      "until": { "kind": "element", "selector": { "text": "目标内容" } },
      "steps": [{ "kind": "call", "name": "mobile_swipe_on_screen", "arguments": { "direction": "up" } }]
    }
  ]
}
```

示例中的控件标识、文字和坐标必须替换为应用实际值。

- `call` 的 arguments 使用原工具参数，不允许覆盖 device。`target` 仅用于点击、双击和长按，不能与 ref/x/y 同时提供。每次尝试都重新获取引用；匹配必须唯一，明确禁用的控件不能点击。也可提供原始坐标或引用，但固定引用不会自动刷新。
- `expect` 在操作后重新读取状态并等待，默认最多 10 秒；`verifyTimeoutMs` 范围 0–60000。检查失败会使步骤失败，即使底层命令已经执行成功。
- `attempts` 默认 1，显式设为 2 或 3 才会重试整个操作及结果检查。`retryDelayMs` 默认 250，范围 0–5000。输入、提交、点击可能重复生效；需要等待加载时优先调整等待，而不是增加操作次数。失败后没有撤销。
- `if` 立即检查条件，只执行 then 或 else；省略 else 表示空分支。
- `repeat` 必须指定 1–50 的 maxIterations。没有 until 时执行固定次数；有 until 时在第一次操作前以及每轮结束后检查，条件已满足则执行零轮。达到次数上限仍未满足会失败，不当成成功。
- wait 步骤支持独立等待工具的所有时间参数，但不能在 wait 节点指定 device 或 captureOnFailure。
- 最多三层 if/repeat 嵌套，每个列表最多 50 节点，总声明节点最多 200。maxSteps 默认 100、最大 500，计入控制节点、每次执行的步骤和额外重试。超限返回错误及已执行历史。
- 总 timeoutMs 默认 60000、最大 300000 毫秒，是设备操作之间检查的期限。不会强行中断已发出的 HDC/设备命令；该命令自己的超时及取证耗时可能让调用超过总期限。
- 执行前按工具参数 schema 检查所有分支，并检查点击/滑动的坐标完整性及拖拽/缩放参数关系；设备能力、屏幕边界、引用、工具内部的业务限制和操作结果仍需在实际执行步骤检查。共享同一设备的其他客户端仍可能干扰流程，须由调用方协调。

允许 call 使用的工具：

- 点击、双击、长按、输入、按键、滑动、拖拽、缩放、组合手势。
- 启动/终止应用、打开网址。
- 读取界面元素、前台应用、屏幕尺寸、方向，以及设置方向。

不允许调用其他 workflow、batch、云设备、设备连接管理、安装卸载、录屏或定位等会话工具。流程不会执行任意脚本。等待使用 wait 节点；检查使用 expect 或 if/until 条件。

成功返回 `success: true` 和 events；失败通过 MCP 错误返回 failedStep、原始错误及已执行的 events。单步文本输出最多保留 8192 个字符，并用 outputTruncated 标记截断。出现错误后不会执行后续步骤。

## 失败资料

六个新工具默认在失败时采集：

- 实际格式的 `screen.png` 或 `screen.jpg`，不强制转码，最大 32 MiB。
- `device.jsonl`：最多 100 条、8 MiB，采集窗口请求为 1 秒；具体日志来源与格式取决于后端，鸿蒙使用 HiLog，可能包括历史缓冲区。
- `report.json`：原始错误和取证结果。流程错误内包含失败步骤及此前执行历史。

目录名形如 `mobile-mcp-failure-*`，位于 MCP 服务器的系统临时目录；路径不在手机或远程 MCP 客户端机器上。POSIX 系统目录权限为 0700、文件为 0600。文件不会上传；保留到使用者删除或系统清理临时目录。可能含屏幕内容、输入文本和设备日志，分享前自行检查。设 `captureOnFailure: false` 可关闭自动保存。

截图或日志不可读取时，仍尝试剩余项目；errors 会说明缺失资料，不会生成替代图片或掩盖原始失败。workflow 内部只在最终失败后集中取证，不为每次重试重复保存。

统一程序入口、配置模板及 JSON/Markdown 报告见[能力自检与统一验收](harmonyos-acceptance.md)。

## 第二阶段统一真机验收

1. 记录真实系统版本、HDC/UITest/uinput 版本和命令帮助；确认基础发现、截图、中文读取与输入。
2. 在可复位的测试应用中验证拖拽位置变化，双指向内/向外与不同角度缩放，以及组合手势的次序。
3. 验证异步出现/消失、前台应用、屏幕旋转和短暂闪现对 stableForMs 的影响。
4. 验证分支、固定次数循环、until 提前退出和上限失败，检查结果与真实 UI 一致。
5. 人为制造一次可重复的失败，确认显式重试次数、目标刷新及错误历史；使用无交易副作用的测试场景。
6. 中断设备连接，检查输入状态、停止后续操作及诊断缺失报告；确认截图和日志能正常打开，且不会把权限错误当作成功。
7. 再统一验证录屏、剪贴板、日志和按约定保留的系统级定位条件。

以上清单尚未真机执行，模拟测试不能替代它。
