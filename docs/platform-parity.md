# 平台逐工具、逐参数对照

此表对照当前仓库源码，不代表 iOS、Android 或商业鸿蒙的所有系统版本已实测。由实际 MCP schema 与人工审阅的后端说明生成；更新命令：`npm run build && npm run audit:platforms`。

默认 iOS/Android 路径是 `MobileDevice → mobilecli`，因此下文的“转交”只证明本仓库传参，外部 CLI 的平台支持不在这里冒充验证。`MOBILEMCP_LEGACY_ROBOT=1` 的真机路径另使用 `IosRobot` / `AndroidRobot`；iOS 模拟器仍走 MobileDevice。HarmonyOS 在该开关之前分流至 HDC。

证据入口：[路由与工具校验](../src/server.ts)、[默认 iOS/Android 包装器](../src/mobile-device.ts)、[旧 iOS](../src/ios.ts)、[旧 Android](../src/android.ts)、[鸿蒙](../src/harmony.ts)。

每个 device 参数：iOS/Android 使用发现所得 ID，鸿蒙使用 harmony: 前缀 ID；不会把鸿蒙 ID 送入 adb。主机文件路径遵守公共路径校验。所有数值边界以本表 schema 和对应后端额外限制共同决定。

当前覆盖 42 个 mobile 工具。遥测反馈 get_more_tools 不属于设备操作，仍按原有开关提供。

## 工具与后端

| 工具 | iOS / Android | HarmonyOS | 代码依据 |
|---|---|---|---|
| [mobile_list_available_devices](#mobile_list_available_devices) | 合并 mobilecli；旧模式另枚举 go-ios/adb；模拟器 agent 安装在选定设备时发生。 | 合并 hdc list targets，保留原生 harmonyos 平台；HDC 缺失不阻断其他平台。 | [src/server.ts](../src/server.ts)、[src/harmony.ts](../src/harmony.ts)、[src/mobile-device.ts](../src/mobile-device.ts) |
| [mobile_connect_harmony_device](#mobile_connect_harmony_device) | 无对应网络连接工具；不映射至 adb。 | HDC tconn / tdisconn 并核对目标发现状态。 | [src/server.ts](../src/server.ts)、[src/harmony.ts](../src/harmony.ts) |
| [mobile_disconnect_harmony_device](#mobile_disconnect_harmony_device) | 无对应网络连接工具；不映射至 adb。 | HDC tconn / tdisconn 并核对目标发现状态。 | [src/server.ts](../src/server.ts)、[src/harmony.ts](../src/harmony.ts) |
| [mobile_login_to_cloud_provider](#mobile_login_to_cloud_provider) | 原有 mobilecli 云登录，可能需要用户授权。 | 没有鸿蒙云后端。 | [src/server.ts](../src/server.ts)、[src/mobilecli.ts](../src/mobilecli.ts) |
| [mobile_list_remote_devices](#mobile_list_remote_devices) | 原有 mobilecli 云设备目录。 | 目录不承诺鸿蒙设备。 | [src/server.ts](../src/server.ts)、[src/mobilecli.ts](../src/mobilecli.ts) |
| [mobile_allocate_remote_device](#mobile_allocate_remote_device) | 原有云分配参数。 | 不支持鸿蒙云分配。 | [src/server.ts](../src/server.ts)、[src/mobilecli.ts](../src/mobilecli.ts) |
| [mobile_release_remote_device](#mobile_release_remote_device) | 释放云提供商设备。 | 不适用于本地 harmony: ID。 | [src/server.ts](../src/server.ts)、[src/mobilecli.ts](../src/mobilecli.ts) |
| [mobile_list_apps](#mobile_list_apps) | 默认 apps list 使用 appName 字段并回退包名；旧 Android 仅列 launcher 应用且返回包名，旧 iOS 用 go-ios 的名称。 | bm dump -a 列包；bm dump -a -l 返回本地化 label。缺失或冲突时明确回退包名，不解析资源描述符猜名称。 | [src/server.ts](../src/server.ts)、[src/mobile-device.ts](../src/mobile-device.ts)、[src/harmony.ts](../src/harmony.ts)、[src/harmony-apps.ts](../src/harmony-apps.ts)、[src/ios.ts](../src/ios.ts)、[src/android.ts](../src/android.ts) |
| [mobile_get_foreground_app](#mobile_get_foreground_app) | 默认 apps foreground；旧后端没有可选 getForegroundApp。 | 默认显示屏焦点窗口前后核对，UI 树 hostWindowId 映射 bundle/Ability；不把第一个可见窗口当作前台。 显示名称使用系统标签，失败时明确回退包名。 | [src/server.ts](../src/server.ts)、[src/mobile-device.ts](../src/mobile-device.ts)、[src/harmony.ts](../src/harmony.ts)、[src/harmony-apps.ts](../src/harmony-apps.ts) |
| [mobile_launch_app](#mobile_launch_app) | 默认转交 mobilecli；旧后端以 ios.ts / android.ts 为准。 | aa start；locale 非空明确报错。 | [src/server.ts](../src/server.ts)、[src/mobile-device.ts](../src/mobile-device.ts)、[src/harmony.ts](../src/harmony.ts)、[src/ios.ts](../src/ios.ts)、[src/android.ts](../src/android.ts) |
| [mobile_terminate_app](#mobile_terminate_app) | 默认转交 mobilecli；旧后端以 ios.ts / android.ts 为准。 | aa force-stop。 | [src/server.ts](../src/server.ts)、[src/mobile-device.ts](../src/mobile-device.ts)、[src/harmony.ts](../src/harmony.ts) |
| [mobile_install_app](#mobile_install_app) | 默认转交 mobilecli；旧后端以 ios.ts / android.ts 为准。 | HAP 安装；签名和权限仍需目标系统允许。 | [src/server.ts](../src/server.ts)、[src/mobile-device.ts](../src/mobile-device.ts)、[src/harmony.ts](../src/harmony.ts) |
| [mobile_uninstall_app](#mobile_uninstall_app) | 默认转交 mobilecli；旧后端以 ios.ts / android.ts 为准。 | bm uninstall；不会把卸载失败当成成功。 | [src/server.ts](../src/server.ts)、[src/mobile-device.ts](../src/mobile-device.ts)、[src/harmony.ts](../src/harmony.ts) |
| [mobile_get_screen_size](#mobile_get_screen_size) | 默认 device info；旧 iOS WDA 尺寸、旧 Android wm size/density。 | 原始截图像素，scale=1；显示尺寸检查仍需截图权限。 | [src/server.ts](../src/server.ts)、[src/mobile-device.ts](../src/mobile-device.ts)、[src/harmony.ts](../src/harmony.ts)、[src/ios.ts](../src/ios.ts)、[src/android.ts](../src/android.ts) |
| [mobile_click_on_screen_at_coordinates](#mobile_click_on_screen_at_coordinates) | 默认 io tap/longpress；双击解析一次 ref 后连续点击。旧后端走 WDA 或 adb。 | UITest click/doubleClick/longClick，自定义长按使用 uinput，失败尝试抬指恢复。 | [src/server.ts](../src/server.ts)、[src/mobile-device.ts](../src/mobile-device.ts)、[src/harmony.ts](../src/harmony.ts)、[src/ios.ts](../src/ios.ts)、[src/android.ts](../src/android.ts) |
| [mobile_double_tap_on_screen](#mobile_double_tap_on_screen) | 默认 io tap/longpress；双击解析一次 ref 后连续点击。旧后端走 WDA 或 adb。 | UITest click/doubleClick/longClick，自定义长按使用 uinput，失败尝试抬指恢复。 | [src/server.ts](../src/server.ts)、[src/mobile-device.ts](../src/mobile-device.ts)、[src/harmony.ts](../src/harmony.ts)、[src/ios.ts](../src/ios.ts)、[src/android.ts](../src/android.ts) |
| [mobile_long_press_on_screen_at_coordinates](#mobile_long_press_on_screen_at_coordinates) | 默认 io tap/longpress；双击解析一次 ref 后连续点击。旧后端走 WDA 或 adb。 | UITest click/doubleClick/longClick，自定义长按使用 uinput，失败尝试抬指恢复。 | [src/server.ts](../src/server.ts)、[src/mobile-device.ts](../src/mobile-device.ts)、[src/harmony.ts](../src/harmony.ts)、[src/ios.ts](../src/ios.ts)、[src/android.ts](../src/android.ts) |
| [mobile_list_elements_on_screen](#mobile_list_elements_on_screen) | 默认转交 mobilecli；旧后端以 ios.ts / android.ts 为准。 | 解析 UITest attributes/children；中文、bounds 和状态保留，生成 @h 引用。 | [src/server.ts](../src/server.ts)、[src/mobile-device.ts](../src/mobile-device.ts)、[src/harmony.ts](../src/harmony.ts)、[src/format-elements.ts](../src/format-elements.ts) |
| [mobile_press_button](#mobile_press_button) | 默认转交 mobilecli；旧后端以 ios.ts / android.ts 为准。 | UITest keyEvent；新增 DPAD 2012–2016 与 RECENT 10011 的官方键码，设备响应待验证。 | [src/server.ts](../src/server.ts)、[src/mobile-device.ts](../src/mobile-device.ts)、[src/harmony.ts](../src/harmony.ts) |
| [mobile_open_url](#mobile_open_url) | 默认转交 mobilecli；旧后端以 ios.ts / android.ts 为准。 | aa start -A ohos.want.action.viewData -U。 | [src/server.ts](../src/server.ts)、[src/mobile-device.ts](../src/mobile-device.ts)、[src/harmony.ts](../src/harmony.ts) |
| [mobile_swipe_on_screen](#mobile_swipe_on_screen) | 默认转交 mobilecli；旧后端以 ios.ts / android.ts 为准。 | UITest swipe，端点保持屏幕范围内。 | [src/server.ts](../src/server.ts)、[src/mobile-device.ts](../src/mobile-device.ts)、[src/harmony.ts](../src/harmony.ts) |
| [mobile_type_keys](#mobile_type_keys) | 默认转交 mobilecli；旧后端以 ios.ts / android.ts 为准。 | UITest uiInput text + 可选 Enter。 | [src/server.ts](../src/server.ts)、[src/mobile-device.ts](../src/mobile-device.ts)、[src/harmony.ts](../src/harmony.ts)、[src/android.ts](../src/android.ts) |
| [mobile_save_screenshot](#mobile_save_screenshot) | 默认 mobilecli 原生处理；旧 iOS/Android 只返回原始 PNG。 | 三种截图命令回退，完整解码，再用主机 sharp 编码/缩放；输入限制64MiB/64MP，截图坐标映射使用原屏幕尺寸。 | [src/server.ts](../src/server.ts)、[src/mobile-device.ts](../src/mobile-device.ts)、[src/harmony.ts](../src/harmony.ts)、[src/screenshot-transform.ts](../src/screenshot-transform.ts)、[src/coordinate-mapping.ts](../src/coordinate-mapping.ts) |
| [mobile_take_screenshot](#mobile_take_screenshot) | 默认 mobilecli 原生处理；旧 iOS/Android 只返回原始 PNG。 | 三种截图命令回退，完整解码，再用主机 sharp 编码/缩放；输入限制64MiB/64MP，截图坐标映射使用原屏幕尺寸。 | [src/server.ts](../src/server.ts)、[src/mobile-device.ts](../src/mobile-device.ts)、[src/harmony.ts](../src/harmony.ts)、[src/screenshot-transform.ts](../src/screenshot-transform.ts)、[src/coordinate-mapping.ts](../src/coordinate-mapping.ts) |
| [mobile_set_orientation](#mobile_set_orientation) | 默认转交 mobilecli；旧后端以 ios.ts / android.ts 为准。 | 不更改旋转锁；应用/旋转锁限制可导致失败。 | [src/server.ts](../src/server.ts)、[src/mobile-device.ts](../src/mobile-device.ts)、[src/harmony.ts](../src/harmony.ts) |
| [mobile_fold_device](#mobile_fold_device) | 默认 device fold；旧后端没有 fold。 | 检查开发者模式/命令支持，注入 named 状态并读回；Mate60Pro 非折叠不能提供折叠能力。 | [src/server.ts](../src/server.ts)、[src/mobile-device.ts](../src/mobile-device.ts)、[src/harmony.ts](../src/harmony.ts) |
| [mobile_set_location](#mobile_set_location) | 默认 device location set/clear；旧后端无可选方法。 | 需要平台构建、系统身份及 MOCK_LOCATION 授权；本阶段不把源码/会话模拟当成部署成功。 | [src/server.ts](../src/server.ts)、[src/mobile-device.ts](../src/mobile-device.ts)、[src/harmony-location.ts](../src/harmony-location.ts)、[native/harmony-location/README.md](../native/harmony-location/README.md) |
| [mobile_clipboard](#mobile_clipboard) | 默认 io clipboard；旧后端没有统一读写接口。 | 需要系统 pasteboard CLI 与权限；不自动授权。 | [src/server.ts](../src/server.ts)、[src/mobile-device.ts](../src/mobile-device.ts)、[src/harmony-clipboard.ts](../src/harmony-clipboard.ts) |
| [mobile_get_device_logs](#mobile_get_device_logs) | 默认 CLI 实时流，30秒无新日志超时；旧后端无此接口。 | HiLog 含已有缓冲区，30秒总期限；不假装与 silence timeout 相同。 | [src/server.ts](../src/server.ts)、[src/mobile-device.ts](../src/mobile-device.ts)、[src/harmony-logs.ts](../src/harmony-logs.ts) |
| [mobile_get_orientation](#mobile_get_orientation) | 默认转交 mobilecli；旧后端以 ios.ts / android.ts 为准。 | 以原始截图宽高判定 portrait/landscape，不提供正反方向四象限。 | [src/server.ts](../src/server.ts)、[src/mobile-device.ts](../src/mobile-device.ts)、[src/harmony.ts](../src/harmony.ts) |
| [mobile_start_screen_recording](#mobile_start_screen_recording) | mobilecli screenrecord 子进程；不经旧 Robot。 | SDK原生录屏组件，无音频；启动要系统确认，组件在主机配置后部署。 | [src/server.ts](../src/server.ts)、[src/harmony-recording.ts](../src/harmony-recording.ts)、[native/harmony-recorder/README.md](../native/harmony-recorder/README.md)、[src/mobilecli.ts](../src/mobilecli.ts) |
| [mobile_stop_screen_recording](#mobile_stop_screen_recording) | 停止本进程记录的 CLI 会话；结果由原有收尾路径决定。 | 必须收集当前或已自动停止的会话；核对终止事件、MP4盒结构并保存。结构检查不是视频可播放验收。 | [src/server.ts](../src/server.ts)、[src/harmony-recording.ts](../src/harmony-recording.ts)、[src/mobilecli.ts](../src/mobilecli.ts) |
| [mobile_list_crashes](#mobile_list_crashes) | 直接 mobilecli crashes list。 | 列固定faultlogger目录中的支持类型，权限不足报错。 | [src/server.ts](../src/server.ts)、[src/harmony-crashes.ts](../src/harmony-crashes.ts)、[src/mobilecli.ts](../src/mobilecli.ts) |
| [mobile_get_crash](#mobile_get_crash) | 直接 mobilecli crashes get。 | 保留错误文本内容，不将报告里的 Error 当作命令错误。 | [src/server.ts](../src/server.ts)、[src/harmony-crashes.ts](../src/harmony-crashes.ts)、[src/mobilecli.ts](../src/mobilecli.ts) |
| [mobile_get_harmony_capabilities](#mobile_get_harmony_capabilities) | 此工具限定 harmony: ID。 | 命令、功能、权限和组件分项available/unavailable/unknown；失联也返回unknown报告。 | [src/server.ts](../src/server.ts)、[src/harmony-capabilities.ts](../src/harmony-capabilities.ts) |
| [mobile_drag_on_screen](#mobile_drag_on_screen) | 这三个新增工具当前明确限定鸿蒙；不声称已扩展iOS/Android。 | 真实双指用同一uinput调用；组合手势之间抬指；中断后多指释放状态未知。 | [src/server.ts](../src/server.ts)、[src/automation-tools.ts](../src/automation-tools.ts)、[src/harmony-gestures.ts](../src/harmony-gestures.ts)、[src/harmony.ts](../src/harmony.ts) |
| [mobile_pinch_on_screen](#mobile_pinch_on_screen) | 这三个新增工具当前明确限定鸿蒙；不声称已扩展iOS/Android。 | 真实双指用同一uinput调用；组合手势之间抬指；中断后多指释放状态未知。 | [src/server.ts](../src/server.ts)、[src/automation-tools.ts](../src/automation-tools.ts)、[src/harmony-gestures.ts](../src/harmony-gestures.ts)、[src/harmony.ts](../src/harmony.ts) |
| [mobile_perform_gestures](#mobile_perform_gestures) | 这三个新增工具当前明确限定鸿蒙；不声称已扩展iOS/Android。 | 真实双指用同一uinput调用；组合手势之间抬指；中断后多指释放状态未知。 | [src/server.ts](../src/server.ts)、[src/automation-tools.ts](../src/automation-tools.ts)、[src/harmony-gestures.ts](../src/harmony-gestures.ts)、[src/harmony.ts](../src/harmony.ts) |
| [mobile_wait_for_condition](#mobile_wait_for_condition) | 共用编排层；依赖Robot的读能力，旧后端前台应用检查不可用。 | 同一层；界面读取失败绝不当成元素消失。 | [src/server.ts](../src/server.ts)、[src/automation.ts](../src/automation.ts)、[src/automation-tools.ts](../src/automation-tools.ts) |
| [mobile_assert_condition](#mobile_assert_condition) | 共用检查层，能力受后端限制。 | 中文精确/包含匹配；presence不证明未被遮挡。 | [src/server.ts](../src/server.ts)、[src/automation.ts](../src/automation.ts)、[src/automation-tools.ts](../src/automation-tools.ts) |
| [mobile_run_workflow](#mobile_run_workflow) | 共用编排；target需要后端提供ref方法，旧后端不支持ref。 | 共享设备无并发隔离；动作后引用过期，target每次重新定位；无撤销。 | [src/server.ts](../src/server.ts)、[src/automation.ts](../src/automation.ts)、[src/automation-tools.ts](../src/automation-tools.ts) |
| [mobile_batch_commands](#mobile_batch_commands) | 共用原有工具回调。 | 与通用层相同；步骤可以覆盖device（workflow禁止）。 | [src/server.ts](../src/server.ts)、[src/server.ts](../src/server.ts) |

## 参数逐项核查

嵌套参数的共同语义见本表末尾；arguments 使用目标工具本节的参数，不能据此绕过后端限制。

### mobile_list_available_devices

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| 无 | — | 无调用参数；后端差异见上表 |

### mobile_connect_harmony_device

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| address | `{"required":true,"type":"string"}` | 显式 host:port；IPv4、IPv6 或主机名，校验后只连接/断开目标。未收尾录屏或定位会话阻止连接改变。 |

### mobile_disconnect_harmony_device

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| address | `{"required":true,"type":"string"}` | 显式 host:port；IPv4、IPv6 或主机名，校验后只连接/断开目标。未收尾录屏或定位会话阻止连接改变。 |

### mobile_login_to_cloud_provider

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| 无 | — | 无调用参数；后端差异见上表 |

### mobile_list_remote_devices

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| 无 | — | 无调用参数；后端差异见上表 |

### mobile_allocate_remote_device

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| platform | `{"required":true,"type":"string","enum":["ios","android"]}` | 仅 ios/android，不允许 harmonyos。 |
| name | `{"required":false,"type":"string"}` | 传给云提供商的设备名称筛选。 |
| version | `{"required":false,"type":"array"}` | 传给提供商的版本筛选。 |
| type | `{"required":false,"type":"string","enum":["real"]}` | 传给提供商的设备类型筛选。 |
| wait | `{"required":false,"type":"boolean"}` | 是否等待分配结果；沿用提供商语义。 |
| timeoutSeconds | `{"required":false,"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991}` | 等待分配的秒数；不用于本地 HDC。 |

### mobile_release_remote_device

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| device | `{"required":true,"type":"string"}` | 发现所得设备 ID；鸿蒙必须使用 harmony: 前缀。 |

### mobile_list_apps

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| device | `{"required":true,"type":"string"}` | 发现所得设备 ID；鸿蒙必须使用 harmony: 前缀。 |

### mobile_get_foreground_app

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| device | `{"required":true,"type":"string"}` | 发现所得设备 ID；鸿蒙必须使用 harmony: 前缀。 |

### mobile_launch_app

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| device | `{"required":true,"type":"string"}` | 发现所得设备 ID；鸿蒙必须使用 harmony: 前缀。 |
| packageName | `{"required":true,"type":"string"}` | iOS/Android 为包名；鸿蒙额外接受 bundleName/AbilityName，未给 Ability 时使用系统解析。 |
| locale | `{"required":false,"type":"string"}` | 默认包装器转交 --locale；旧 iOS 传 AppleLanguages/AppleLocale；旧 Android 尝试 cmd locale set-app-locales（API33+），失败会忽略。鸿蒙明确不支持按应用启动语言覆盖。 |

### mobile_terminate_app

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| device | `{"required":true,"type":"string"}` | 发现所得设备 ID；鸿蒙必须使用 harmony: 前缀。 |
| packageName | `{"required":true,"type":"string"}` | iOS/Android 包名；鸿蒙仅 bundleName，不接受 /Ability。 |

### mobile_install_app

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| device | `{"required":true,"type":"string"}` | 发现所得设备 ID；鸿蒙必须使用 harmony: 前缀。 |
| path | `{"required":true,"type":"string"}` | 主机文件路径，共同校验允许扩展名；iOS/Android 由后端安装；鸿蒙仅签名 .hap，上传临时设备路径后 bm install。 |

### mobile_uninstall_app

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| device | `{"required":true,"type":"string"}` | 发现所得设备 ID；鸿蒙必须使用 harmony: 前缀。 |
| packageName | `{"required":true,"type":"string"}` | 设备包名；鸿蒙校验 bundleName 后 bm uninstall -n。 |

### mobile_get_screen_size

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| device | `{"required":true,"type":"string"}` | 发现所得设备 ID；鸿蒙必须使用 harmony: 前缀。 |

### mobile_click_on_screen_at_coordinates

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| device | `{"required":true,"type":"string"}` | 发现所得设备 ID；鸿蒙必须使用 harmony: 前缀。 |
| x | `{"required":false,"type":"number","minimum":0}` | 原始屏幕坐标，和 y 成对；给 ref 时 ref 优先；鸿蒙取整。 |
| y | `{"required":false,"type":"number","minimum":0}` | 与 x 同上；各平台屏幕单位见 get_screen_size，截图缩放后须坐标换算。 |
| ref | `{"required":false,"type":"string"}` | 默认包装器支持；旧 iOS/Android 没有 ref 方法。鸿蒙为最近快照引用，动作后失效，执行前再次核对布局。 |

### mobile_double_tap_on_screen

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| device | `{"required":true,"type":"string"}` | 发现所得设备 ID；鸿蒙必须使用 harmony: 前缀。 |
| x | `{"required":false,"type":"number","minimum":0}` | 原始屏幕坐标，和 y 成对；给 ref 时 ref 优先；鸿蒙取整。 |
| y | `{"required":false,"type":"number","minimum":0}` | 与 x 同上；各平台屏幕单位见 get_screen_size，截图缩放后须坐标换算。 |
| ref | `{"required":false,"type":"string"}` | 默认包装器支持；旧 iOS/Android 没有 ref 方法。鸿蒙为最近快照引用，动作后失效，执行前再次核对布局。 |

### mobile_long_press_on_screen_at_coordinates

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| device | `{"required":true,"type":"string"}` | 发现所得设备 ID；鸿蒙必须使用 harmony: 前缀。 |
| x | `{"required":false,"type":"number","minimum":0}` | 原始屏幕坐标，和 y 成对；给 ref 时 ref 优先；鸿蒙取整。 |
| y | `{"required":false,"type":"number","minimum":0}` | 与 x 同上；各平台屏幕单位见 get_screen_size，截图缩放后须坐标换算。 |
| ref | `{"required":false,"type":"string"}` | 默认包装器支持；旧 iOS/Android 没有 ref 方法。鸿蒙为最近快照引用，动作后失效，执行前再次核对布局。 |
| duration | `{"required":false,"type":"number","minimum":1,"maximum":10000}` | 单位毫秒；默认包装器/旧后端按 server 默认值传入。鸿蒙省略时使用系统 longClick；显式值取整后 1–10000，依赖 uinput down/interval/up。 |

### mobile_list_elements_on_screen

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| device | `{"required":true,"type":"string"}` | 发现所得设备 ID；鸿蒙必须使用 harmony: 前缀。 |
| format | `{"required":false,"type":"string","enum":["text","json"]}` | text/json 只影响主机输出格式，各后端返回同一 ScreenElement 结构；可用字段取决于设备树。 |

### mobile_press_button

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| device | `{"required":true,"type":"string"}` | 发现所得设备 ID；鸿蒙必须使用 harmony: 前缀。 |
| button | `{"required":true,"type":"string"}` | 名称不等价：Android 包含 BACK/POWER/APP_SWITCH/DPAD；iOS 支持 HOME/VOLUME/ENTER/LOCK；鸿蒙包含 HOME/BACK/VOLUME/ENTER/BACKSPACE/POWER/APP_SWITCH/DPAD，不把 LOCK 当作 POWER。 |

### mobile_open_url

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| device | `{"required":true,"type":"string"}` | 发现所得设备 ID；鸿蒙必须使用 harmony: 前缀。 |
| url | `{"required":true,"type":"string"}` | 公共层默认只允许 http/https；MOBILEMCP_ALLOW_UNSAFE_URLS=1 才允许其他 scheme。鸿蒙使用 aa viewData，原始查询参数经 shell 转义。 |

### mobile_swipe_on_screen

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| device | `{"required":true,"type":"string"}` | 发现所得设备 ID；鸿蒙必须使用 harmony: 前缀。 |
| direction | `{"required":true,"type":"string","enum":["up","down","left","right"]}` | up/down/left/right；坐标轴方向一致。 |
| x | `{"required":false,"type":"number","minimum":0}` | 与 y 同时提供或同时省略；省略时使用后端中心。 |
| y | `{"required":false,"type":"number","minimum":0}` | 与 x 成对。 |
| distance | `{"required":false,"type":"number","minimum":1}` | 指定起点时传给后端；没有起点时公共回调调用 swipe(direction)，distance 不生效（各平台共同现状）。默认包装器 400 像素；鸿蒙中心滑动为方向尺寸 30%，自定义起点默认 400，边界钳制。 |

### mobile_type_keys

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| device | `{"required":true,"type":"string"}` | 发现所得设备 ID；鸿蒙必须使用 harmony: 前缀。 |
| text | `{"required":true,"type":"string"}` | Unicode 字符串；默认 mobilecli 转交，旧 Android 非 ASCII 需要 DeviceKit；鸿蒙要求 UITest text（API18+），写入结果须回读。 |
| submit | `{"required":false,"type":"boolean"}` | 默认 false；true 在文本输入后另按 ENTER，不能保证业务已提交。 |

### mobile_save_screenshot

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| device | `{"required":true,"type":"string"}` | 发现所得设备 ID；鸿蒙必须使用 harmony: 前缀。 |
| saveTo | `{"required":true,"type":"string"}` | 主机输出路径，扩展名 png/jpg/jpeg 决定编码；遵守公共输出路径校验。 |
| quality | `{"required":false,"type":"integer","minimum":1,"maximum":100}` | JPEG 整数 1–100，take 默认75，鸿蒙 save 默认75；PNG 保持无损，不将 quality 映射成有损调色板。旧后端忽略。 |
| maxSize | `{"required":false,"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991}` | 最大边长，等比缩小不放大；优先于 scale。take 未给两者时默认1024；save 省略则原始尺寸。旧后端忽略。 |
| scale | `{"required":false,"type":"number","exclusiveMinimum":0,"maximum":1}` | 0<scale<=1；仅没有 maxSize 时使用；鸿蒙在主机解码缩放，极小输出至少1像素。旧后端忽略。 |

### mobile_take_screenshot

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| device | `{"required":true,"type":"string"}` | 发现所得设备 ID；鸿蒙必须使用 harmony: 前缀。 |
| format | `{"required":false,"type":"string","enum":["png","jpeg"]}` | png/jpeg，默认 jpeg；默认包装器转交，旧后端仍可能返回 PNG，响应 MIME 按实际内容。鸿蒙主机转换为请求格式。 |
| quality | `{"required":false,"type":"integer","minimum":1,"maximum":100}` | JPEG 整数 1–100，take 默认75，鸿蒙 save 默认75；PNG 保持无损，不将 quality 映射成有损调色板。旧后端忽略。 |
| maxSize | `{"required":false,"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991}` | 最大边长，等比缩小不放大；优先于 scale。take 未给两者时默认1024；save 省略则原始尺寸。旧后端忽略。 |
| scale | `{"required":false,"type":"number","exclusiveMinimum":0,"maximum":1}` | 0<scale<=1；仅没有 maxSize 时使用；鸿蒙在主机解码缩放，极小输出至少1像素。旧后端忽略。 |

### mobile_set_orientation

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| device | `{"required":true,"type":"string"}` | 发现所得设备 ID；鸿蒙必须使用 harmony: 前缀。 |
| orientation | `{"required":true,"type":"string","enum":["portrait","landscape"]}` | portrait/landscape；鸿蒙要求开发者模式及显示服务 -motion，并轮询截图验证方向。 |

### mobile_fold_device

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| device | `{"required":true,"type":"string"}` | 发现所得设备 ID；鸿蒙必须使用 harmony: 前缀。 |
| posture | `{"required":false,"type":"string","enum":["folded","half-open","open"]}` | folded/half-open/open，与 angle 互斥；默认包装器转交；鸿蒙是状态模拟，不移动实体铰链，需可折叠硬件。 |
| angle | `{"required":false,"type":"number","minimum":0,"maximum":180}` | 0–180；原接口说明限定 iOS 对应模拟器；鸿蒙不支持精确角度，明确报错。 |

### mobile_set_location

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| device | `{"required":true,"type":"string"}` | 发现所得设备 ID；鸿蒙必须使用 harmony: 前缀。 |
| latitude | `{"required":false,"type":"number","minimum":-90,"maximum":90}` | 与 longitude 同时提供则设置；两者省略则清除。纬度[-90,90]。 |
| longitude | `{"required":false,"type":"number","minimum":-180,"maximum":180}` | 经度[-180,180]；鸿蒙组件持续发布并校验 mock 标记/坐标，退出时需确认关闭。 |

### mobile_clipboard

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| device | `{"required":true,"type":"string"}` | 发现所得设备 ID；鸿蒙必须使用 harmony: 前缀。 |
| text | `{"required":false,"type":"string"}` | 省略读取，空字符串清空，非空写入。鸿蒙仅纯文本、最多64KiB UTF8、无NUL；保留尾部换行；系统命令保留字 --help 不支持，写后回读。 |

### mobile_get_device_logs

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| device | `{"required":true,"type":"string"}` | 发现所得设备 ID；鸿蒙必须使用 harmony: 前缀。 |
| limit | `{"required":false,"default":100,"type":"integer","minimum":1,"maximum":10000}` | 1–10000，默认100。鸿蒙还受8MiB上限约束。 |
| filter | `{"required":false,"default":[],"type":"array"}` | AND 组合 key=value/key!=value。鸿蒙支持pid/tag/level/subsystem(domain)/message；process/category明确不支持。iOS/Android转交各自后端，字段不能假设相同。 |
| saveTo | `{"required":false,"type":"string"}` | 可选主机 .log/.txt/.jsonl 文件；省略返回 NDJSON 文本。 |

### mobile_get_orientation

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| device | `{"required":true,"type":"string"}` | 发现所得设备 ID；鸿蒙必须使用 harmony: 前缀。 |

### mobile_start_screen_recording

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| device | `{"required":true,"type":"string"}` | 发现所得设备 ID；鸿蒙必须使用 harmony: 前缀。 |
| output | `{"required":false,"type":"string"}` | 可选主机 .mp4 输出，省略用私有临时路径；共同路径校验。 |
| timeLimit | `{"required":false,"type":"number"}` | 单位秒；鸿蒙限制整数1–86400；iOS/Android直接传 CLI，平台范围由CLI决定。 |

### mobile_stop_screen_recording

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| device | `{"required":true,"type":"string"}` | 发现所得设备 ID；鸿蒙必须使用 harmony: 前缀。 |

### mobile_list_crashes

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| device | `{"required":true,"type":"string"}` | 发现所得设备 ID；鸿蒙必须使用 harmony: 前缀。 |

### mobile_get_crash

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| device | `{"required":true,"type":"string"}` | 发现所得设备 ID；鸿蒙必须使用 harmony: 前缀。 |
| id | `{"required":true,"type":"string"}` | 必须来自列表；鸿蒙仅支持目录内已列出的常规文件，拒绝路径穿越/符号链接，大小上限8MiB。 |

### mobile_get_harmony_capabilities

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| device | `{"required":true,"type":"string","pattern":"^harmony:"}` | 发现所得设备 ID；鸿蒙必须使用 harmony: 前缀。自检可报告未连接状态。 |
| probeReads | `{"required":false,"default":false,"type":"boolean"}` | 默认false只查命令/帮助/组件；true额外读UI/截图/应用/剪贴板/日志/崩溃列表/前台，不返回敏感内容。不执行写入测试，写权限保持unknown。 |

### mobile_drag_on_screen

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| device | `{"required":true,"type":"string","minLength":1}` | 发现所得设备 ID；鸿蒙必须使用 harmony: 前缀。 |
| from | `{"required":true,"type":"object"}` | 起点{x,y}为原屏幕整数像素。 |
| to | `{"required":true,"type":"object"}` | 终点{x,y}；初始和每步运行时边界检查，不钳制。 |
| pressMs | `{"required":false,"default":500,"type":"integer","minimum":500,"maximum":14500}` | 500–14500毫秒，默认500。 |
| durationMs | `{"required":false,"default":1000,"type":"integer","minimum":1000,"maximum":15000}` | 1000–15000毫秒，默认1000，含按住时长，移动至少500ms。 |
| captureOnFailure | `{"required":false,"default":true,"type":"boolean"}` | 默认true，失败采集私有主机截图/日志/报告；取证失败不能覆盖操作失败。 |

### mobile_pinch_on_screen

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| device | `{"required":true,"type":"string","minLength":1}` | 发现所得设备 ID；鸿蒙必须使用 harmony: 前缀。 |
| center | `{"required":true,"type":"object"}` | 中心{x,y}原屏幕像素。 |
| startDistance | `{"required":true,"type":"integer","minimum":2,"maximum":10000}` | 两指完整起始间距2–10000，换算坐标必须在屏幕内。 |
| endDistance | `{"required":true,"type":"integer","minimum":2,"maximum":10000}` | 最终间距2–10000，不能等于起始值；向外变大，向内变小。 |
| angle | `{"required":false,"default":0,"type":"number","minimum":-180,"maximum":180}` | 相对水平轴-180–180度，默认0；坐标取整。 |
| durationMs | `{"required":false,"default":500,"type":"integer","minimum":1,"maximum":15000}` | 1–15000毫秒，默认500。 |
| captureOnFailure | `{"required":false,"default":true,"type":"boolean"}` | 默认true；仅在失败时保存诊断。 |

### mobile_perform_gestures

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| device | `{"required":true,"type":"string","minLength":1}` | 发现所得设备 ID；鸿蒙必须使用 harmony: 前缀。 |
| gestures | `{"required":true,"minItems":1,"maxItems":20,"type":"array"}` | 1–20个tap/hold/drag/pinch/pause节点；请求时长总和<=60000ms，全部初始参数预检查。 |
| captureOnFailure | `{"required":false,"default":true,"type":"boolean"}` | 默认true；失败停止后续手势并记录已有动作可能生效。 |

### mobile_wait_for_condition

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| device | `{"required":true,"type":"string","minLength":1}` | 发现所得设备 ID；鸿蒙必须使用 harmony: 前缀。 |
| condition | `{"required":true,"variants":["object","object","object"]}` | element/app/orientation；嵌套选择器见下文。 |
| timeoutMs | `{"required":false,"default":10000,"type":"integer","minimum":0,"maximum":60000}` | 0–60000毫秒，默认10000；0只检查一次。 |
| pollIntervalMs | `{"required":false,"default":250,"type":"integer","minimum":50,"maximum":5000}` | 50–5000毫秒，默认250。 |
| stableForMs | `{"required":false,"default":0,"type":"integer","minimum":0,"maximum":10000}` | 0–10000毫秒，默认0且不超过timeoutMs；连续观测匹配，不保证两次采样之间未变化。 |
| captureOnFailure | `{"required":false,"default":true,"type":"boolean"}` | 默认true；失败取证写主机临时目录。 |

### mobile_assert_condition

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| device | `{"required":true,"type":"string","minLength":1}` | 发现所得设备 ID；鸿蒙必须使用 harmony: 前缀。 |
| condition | `{"required":true,"variants":["object","object","object"]}` | 与等待相同，立即检查一次，不匹配返回MCP错误。 |
| captureOnFailure | `{"required":false,"default":true,"type":"boolean"}` | 默认true；取证与检查结果独立。 |

### mobile_run_workflow

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| device | `{"required":true,"type":"string","minLength":1}` | 发现所得设备 ID；鸿蒙必须使用 harmony: 前缀。 |
| steps | `{"required":true,"minItems":1,"maxItems":50,"type":"array"}` | call/wait/if/repeat，最多3层控制结构、每列表50、总声明200；参数和所有分支预检查。 |
| timeoutMs | `{"required":false,"default":60000,"type":"integer","minimum":1,"maximum":300000}` | 1–300000毫秒，默认60000；设备调用之间检查，不强行中断在途命令，取证另耗时。 |
| maxSteps | `{"required":false,"default":100,"type":"integer","minimum":1,"maximum":500}` | 1–500，默认100；计入控制节点、执行步骤和额外重试。 |
| captureOnFailure | `{"required":false,"default":true,"type":"boolean"}` | 默认true；最后一次失败才取证，不为每次重试重复保存。 |

### mobile_batch_commands

| 参数 | 公共 schema 约束 | 平台处理与差异 |
|---|---|---|
| device | `{"required":true,"type":"string"}` | 发现所得设备 ID；鸿蒙必须使用 harmony: 前缀。 |
| steps | `{"required":true,"minItems":1,"type":"array"}` | 数组{name,arguments}，逐个按工具schema解析；禁止嵌套batch和inline截图。与workflow不同，参数不是整批提前校验。 |
| stopOnError | `{"required":false,"type":"boolean"}` | 默认true停止于首个失败；false继续；原工具以文本列出失败，不保证外层isError为true。 |
| listElementsAtEnd | `{"required":false,"type":"boolean"}` | 默认false；true末尾重读元素，返回新引用。 |

## 嵌套参数与运行语义

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
