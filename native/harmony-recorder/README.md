# 原生录屏组件

使用 AVScreenCapture 文件录制接口输出 H.264/MP4，默认不采集音频。包含设备端源码、CMake 构建入口和主机状态测试，已接入 MCP 部署、停止控制及文件回收。设置 HARMONY_RECORDER_PATH 为 SDK 构建产物的绝对路径后使用录屏工具。

## 主机状态测试

```sh
cmake -S native/harmony-recorder -B /tmp/mobile-mcp-recorder-tests -DMOBILE_MCP_HOST_TESTS=ON
cmake --build /tmp/mobile-mcp-recorder-tests
ctest --test-dir /tmp/mobile-mcp-recorder-tests --output-on-failure
```

测试使用模拟后端，覆盖正常限时录制、取消授权、授权超时、初始化失败、启动失败、停止失败、系统停止、异步错误和手动停止，不生成视频。macOS 工具链不匹配时，可通过 `CMAKE_CXX_COMPILER` 和 `CMAKE_OSX_SYSROOT` 指定配套 Xcode 编译器与 SDK，不必修改系统全局配置。

## 设备构建

需要包含 AVScreenCapture C API 的鸿蒙/OpenHarmony Native SDK。示例中的 OHOS_NDK 是实际 SDK native 目录：

```sh
cmake -S native/harmony-recorder -B /tmp/mobile-mcp-recorder-device \
  -DCMAKE_TOOLCHAIN_FILE="$OHOS_NDK/build/cmake/ohos.toolchain.cmake" \
  -DOHOS_ARCH=arm64-v8a -DOHOS_STL=c++_static -DCMAKE_BUILD_TYPE=Release
cmake --build /tmp/mobile-mcp-recorder-device
```

目标链接 `native_avscreen_capture`。已用 OpenHarmony 6.1 LTS 的 Native SDK 6.1.0.35（API 23，macOS arm64 工具链）完成 arm64-v8a 交叉编译与链接，产物为 AArch64 ELF，动态依赖 libnative_avscreen_capture.so 和 libc.so。本地构建产物保存在 build/arm64-v8a/mobile-mcp-recorder，构建元数据位于同目录 build-info.json；这些生成文件不提交 Git。此结果不证明商业手机允许该执行身份或已经完成录屏。详细证据见[第一阶段验证记录](../../docs/harmonyos-phase1-verification.md)。

## 执行协议

```text
mobile-mcp-recorder output.mp4 stop-file width height duration-seconds
```

宽高必须为 2–16384 的偶数。时长 0 表示持续到停止，正数最大 86400 秒。输出采用排他创建，拒绝覆盖已有文件和跟随最终路径符号链接，权限 0600。

stop-file 出现、SIGINT/SIGTERM/SIGHUP、父进程变化或限时到达会触发停止。授权等待最多 60 秒，保留系统授权流程，不自动批准。

- 系统 STARTED 回调后才输出 `{"event":"started","pid":123}`。
- 停止、释放实例、同步文件且输出非空后输出 `{"event":"stopped","bytes":12345}`，退出码为 0。
- 失败输出 `{"event":"error","code":数值}` 并以非零退出，不生成替代视频；可能留下未完成文件，调用方不得将其视为成功产物。

设备是否允许该执行身份调用录屏 API、是否需要签名应用承载，需 SDK 和第二阶段手机验证。MCP 端会核对完成事件、进程退出、文件大小和 MP4 顶层结构后保存；这不能替代真机逐帧解码验证。
