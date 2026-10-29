# 原生录屏组件

使用 AVScreenCapture 文件录制接口输出 H.264/MP4，默认不采集音频。当前包含设备端源码、CMake 构建入口和主机状态测试，尚未接入 MCP 部署、停止控制及文件回收。

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

目标链接 `native_avscreen_capture`。实际 SDK 交叉编译尚未执行。已验证主机状态测试及公开 AVScreenCapture 头文件的语法兼容；语法检查中未使用的外部缓冲区/窗口指针类型采用前向声明，不等于设备链接验证。

## 执行协议

```text
mobile-mcp-recorder output.mp4 stop-file width height duration-seconds
```

宽高必须为 2–16384 的偶数。时长 0 表示持续到停止，正数最大 86400 秒。输出采用排他创建，拒绝覆盖已有文件和跟随最终路径符号链接，权限 0600。

stop-file 出现、SIGINT/SIGTERM/SIGHUP、父进程变化或限时到达会触发停止。授权等待最多 60 秒，保留系统授权流程，不自动批准。

- 系统 STARTED 回调后才输出 `{"event":"started","pid":123}`。
- 停止、释放实例、同步文件且输出非空后输出 `{"event":"stopped","bytes":12345}`，退出码为 0。
- 失败输出 `{"event":"error","code":数值}` 并以非零退出，不生成替代视频；可能留下未完成文件，调用方不得将其视为成功产物。

设备是否允许该执行身份调用录屏 API、是否需要签名应用承载，需 SDK 和第二阶段手机验证。MCP 端仍需检查 MP4 内容并安全保存，不能仅凭文件非空宣告录屏成功。
