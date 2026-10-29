# 鸿蒙接入与中文支持

本地源码增加了实验性的原生 HarmonyOS HDC 后端。它复用现有 MCP 工具，不需要将鸿蒙手机识别成 Android，也不要求鸿蒙路径安装 adb 或 Xcode。此改动尚未发布到 npm，`npx @mobilenext/mobile-mcp@latest` 不会包含这份本地适配。

第一阶段交付源码适配、功能对照、编译、代码检查和模拟 HDC 的自动化测试；第二阶段连接手机逐项实跑并修复差异。Mate 60 Pro / 鸿蒙 7 是待验收目标，不代表已经验证兼容。`OpenHarmony` 分支另有 GitHub Actions 执行构建、检查和测试，不调用设备端到端流程。

## 环境准备

1. 从 DevEco Studio SDK 或华为 Command Line Tools 获取 HDC，将 `hdc` 加入 PATH；也可以设置 `HDC_PATH` 为可执行文件的绝对路径。
2. 手机上打开开发者选项和 USB 调试，用数据线连接电脑，并在手机上允许这台电脑调试。保持手机解锁。
3. 执行 `hdc list targets`，确认能看到设备连接标识。若使用 `HDC_PATH`，直接执行该路径对应的 HDC。
4. 在仓库目录安装依赖并编译：

```sh
npm ci --ignore-scripts
npm run build
```

让 MCP 客户端启动本地构建的 `lib/index.js`，例如：

```json
{
  "mcpServers": {
    "mobile-mcp-local": {
      "command": "node",
      "args": ["/absolute/path/to/mobile-mcp/lib/index.js"],
      "env": {
        "HDC_PATH": "/absolute/path/to/hdc",
        "MOBILEMCP_DISABLE_TELEMETRY": "1"
      }
    }
  }
}
```

将示例中的仓库路径和 HDC 路径替换为实际路径。如果 `hdc` 已在客户端进程的 PATH 中，可以省略 `HDC_PATH`。这份示例不会自动更改任何客户端配置。

## 能力范围

| 功能 | 当前实现 | 设备侧条件或边界 |
|---|---|---|
| 发现设备 | `hdc list targets` | 返回 `harmony:<连接标识>`；目前面向本地真机，未验证模拟器 |
| 获取界面元素 | `uitest dumpLayout` | 解析 `attributes` / `children`、中文文字、描述、坐标及状态 |
| 点击、双击 | `uitest uiInput click/doubleClick` | 支持坐标或最近一次读取的元素引用 |
| 原生长按 | `uitest uiInput longClick` | 支持坐标或元素引用；省略 `duration` 使用系统默认时长，不能指定自定义时长 |
| 滑动 | `uitest uiInput swipe` | 坐标限制在截图给出的屏幕尺寸内 |
| 文字输入 | `uitest uiInput text` | 需要 API 18+ 对应命令；输入框须先获得焦点，实际写入需回读验证 |
| 按键 | `uitest uiInput keyEvent` | HOME、BACK、ENTER、BACKSPACE、POWER、VOLUME_UP、VOLUME_DOWN |
| 截图、屏幕尺寸、当前方向 | `uitest screenCap` | 返回原始 PNG；暂不缩放，不转换 JPEG，保存时使用 `.png` |
| 设备日志 | `hilog -v epoch` | 先返回已有缓冲区，再持续读取；支持 pid/tag/level/subsystem(domain)/message 筛选，30 秒固定期限，最多 8 MiB；不支持 process/category 筛选 |
| 应用列表 | `bm dump -a` | 应用名当前使用 bundleName |
| 启动、终止应用 | `aa start` / `aa force-stop` | 显式启动可使用 `bundleName/AbilityName`；不假设所有应用入口都叫 EntryAbility |
| 安装、卸载 | `bm install` / `bm uninstall` | 安装仅接受 `.hap`；签名、设备授权及系统安装限制仍然生效 |
| 打开网址 | `aa start -A ohos.want.action.viewData -U` | 上层仍默认仅允许 HTTP/HTTPS |
| 批量执行 | 复用 `mobile_batch_commands` | 使用元素引用的步骤之间需要重新读取元素，或使用已知坐标 |

暂不支持：自定义时长长按、设置屏幕方向、前台应用查询、剪贴板工具、定位覆盖、折叠、录屏和崩溃报告。对应工具返回不支持，不会转交给 Android/iOS 后端。云端设备仍仅支持原项目的 iOS/Android 范围。

每次操作后会清除鸿蒙元素引用；按引用操作前还会重新读取布局。如果布局与引用来自的快照不同，会要求重新读取元素。界面持续变化时，可读取新快照后根据坐标操作；操作与布局校验之间仍可能发生变化。stdio 连接和 HTTP 请求均保留设备引用上下文；共享设备的客户端仍需协调操作，同一设备没有并发操作隔离。

以上属于初步适配，并未实现所有平台能力的完全对等。不支持项是待补齐的差异，需要结合目标系统公开接口、权限及第二阶段实测决定实现方式，不能把“明确返回不支持”当作功能已经复现。

### 第一阶段逐项对照

这里的“已实现”指代码与模拟协议路径，不代表真机验收通过。

| MCP 工具 | 鸿蒙第一阶段状态 |
|---|---|
| `mobile_list_available_devices` | 已实现：合并 HDC 与原有平台的设备 |
| `mobile_list_apps` | 已实现：bundleName 列表 |
| `mobile_launch_app` | 已实现：支持显式 Ability；不支持启动语言覆盖 |
| `mobile_terminate_app` | 已实现 |
| `mobile_install_app` | 已实现：仅 `.hap` |
| `mobile_uninstall_app` | 已实现 |
| `mobile_get_screen_size` | 已实现 |
| `mobile_get_orientation` | 已实现：根据截图宽高判断竖屏/横屏 |
| `mobile_list_elements_on_screen` | 已实现：文字、坐标、状态和临时引用 |
| `mobile_click_on_screen_at_coordinates` | 已实现：坐标/引用 |
| `mobile_double_tap_on_screen` | 已实现：坐标/引用 |
| `mobile_long_press_on_screen_at_coordinates` | 已实现：坐标/引用，仅系统默认时长 |
| `mobile_swipe_on_screen` | 已实现 |
| `mobile_type_keys` | 已实现：UTF-8 传输；实际中文输入待真机验收 |
| `mobile_press_button` | 已实现：见上表限定的按键集合 |
| `mobile_open_url` | 已实现 |
| `mobile_take_screenshot` | 已实现：原始 PNG |
| `mobile_save_screenshot` | 已实现：保存 `.png`，不伪装为 JPEG |
| `mobile_batch_commands` | 已实现：复用统一工具回调 |
| `mobile_get_foreground_app` | 待适配，明确返回不支持 |
| `mobile_set_orientation` | 待适配，明确返回不支持 |
| `mobile_clipboard` | 待适配，明确返回不支持；不等同于 UITest 内部输入机制 |
| `mobile_get_device_logs` | 已实现：HiLog 缓冲区及实时流，NDJSON，筛选及 30 秒固定期限 |
| `mobile_set_location` | 待适配，明确返回不支持 |
| `mobile_fold_device` | 未实现；还受设备是否有折叠硬件限制 |
| `mobile_start_screen_recording` / `mobile_stop_screen_recording` | 待适配，明确返回不支持 |
| `mobile_list_crashes` / `mobile_get_crash` | 待适配，明确返回不支持 |
| `mobile_login_to_cloud_provider` / `mobile_list_remote_devices` / `mobile_allocate_remote_device` / `mobile_release_remote_device` | 保留原云提供商接口，不提供鸿蒙云设备 |

`get_more_tools` 仍是原项目的缺失能力反馈工具，不会安装或动态添加鸿蒙功能。

## 中文支持的实际含义

- **中文指令**：由外部 Agent 理解，框架不限定用户必须使用英文。理解质量取决于接入的模型。
- **中文界面读取**：使用 Unicode 字符串与 UTF-8 传输，保留界面中的中文、中文标点及 Emoji，不依赖 OCR 来提取已在控件树中的文字。
- **中文输入**：原生鸿蒙走 UITest 的文字输入路径。OpenHarmony 实现对不能转换为键盘事件的文本使用剪贴板输入，但商业手机的系统版本、输入框类型及权限可能影响结果，必须真机验证。工具返回没有报错，只能说明命令被接受。
- **工具说明本地化**：已有简体中文 README，但 MCP 工具名、说明和多数错误提示仍是英文；本次未添加完整的语言切换机制。
- **原有 Android 路径**：默认后端将文字交给 mobilecli；旧版 `MOBILEMCP_LEGACY_ROBOT=1` 路径在未安装 Device Kit 时会拒绝非 ASCII 文字。不能将所有平台的中文输入一概视为已经验证。

## 真机验收

先使用一个没有实际业务提交操作的测试输入框，按以下顺序验证：

1. 调用 `mobile_list_available_devices`，检查返回 `platform: "harmonyos"` 和正确的 `harmony:` 设备标识。
2. 调用 `mobile_list_elements_on_screen`，检查中文按钮和输入框内容；再截图检查坐标是否对应实际界面。
3. 点击测试输入框，输入 `你好，鸿蒙！Mate 60 Pro 123🙂`，重新读取界面，逐字比较输入内容。
4. 单独测试空格、单引号、双引号、换行、`&` 和 `$`；确认字符原样写入且没有被当作设备 shell 命令。
5. 检查点击、双击、原生长按、滑动、返回及 Home，并验证旧引用会在操作后报错。

中文从工具传到 HDC 的模拟测试通过，不等于真机输入验收通过；目标 App 不公开输入框文字时，需要结合截图人工确认。

## 官方依据

- [OpenHarmony HDC](https://github.com/openharmony/docs/blob/master/zh-cn/application-dev/dfx/hdc.md)
- [OpenHarmony UITest 命令](https://github.com/openharmony/docs/blob/master/zh-cn/application-dev/application-test/uitest-guidelines.md)
- [UITest 输入实现：InputText](https://github.com/openharmony/testfwk_arkxtest/blob/master/uitest/core/ui_driver.cpp)
- [aa 工具](https://github.com/openharmony/docs/blob/master/zh-cn/application-dev/tools/aa-tool.md)
- [bm 工具](https://github.com/openharmony/docs/blob/master/zh-cn/application-dev/tools/bm-tool.md)

日志接口依据：[OpenHarmony HiLog](https://github.com/openharmony/docs/blob/master/zh-cn/application-dev/dfx/hilog.md)、[华为终端命令说明](https://consumer.huawei.com/cn/support/content/zh-cn16083991/)。日志解析保留不能识别的原始行；带字段筛选时，不具备该字段的行不会命中。
