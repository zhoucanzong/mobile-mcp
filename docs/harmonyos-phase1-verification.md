# 鸿蒙第一阶段验证记录

第一阶段验收范围为工具源码适配、功能对照、模拟验证及 `OpenHarmony` 分支交付。用户已确认：系统级定位保留实验性条件项，平台部署与授权可留到接手机后的第二阶段验证。第一阶段验收通过不代表 Mate 60 Pro / 鸿蒙 7 上所有功能已运行成功。

## 已核对的证据

- 实现提交 `4054c7d5c642cd526525d9fb8cfcd97938e09587` 的[远端 CI](https://github.com/zhoucanzong/mobile-mcp/actions/runs/40915715034)已成功，逐步核对了构建、检查、单元/协议测试与两组原生状态测试的成功结论。补充应用管理完整成功路径后，本地测试结果为 249 项通过。
- `test/server-harmony.test.ts` 验证 MCP 调用、平台路由、跨请求的元素引用、录屏及定位会话。
- `test/harmony*.test.ts` 与 `test/hdc.test.ts` 覆盖界面解析、中文文本、命令转义、临时文件、截图格式、状态确认、失败传播、会话清理与恢复。
- 原生录屏和定位各有 9 个主机模拟状态场景，使用实际 C++ 编译器构建并运行。它们不调用手机系统服务。
- 逐工具状态和条件参见[功能对照](harmonyos.md#第一阶段逐项对照)。现有云提供商接口仍面向原有 iOS/Android 云设备，不宣称提供鸿蒙云设备。

## 录屏组件真实 SDK 构建

从[OpenHarmony 6.1 LTS 发布目录](https://repo.huaweicloud.com/openharmony/os/6.1-LTS/)获取 `L2-SDK-MAC-M1-PUBLIC.tar.gz`，与同目录发布的 SHA256 校验值核对一致：

```text
134fe3f63477f1eb803ec1e33cf2963efd5d86d886f6dc05facc95ddad4794c9
```

使用其中 Native SDK 6.1.0.35，`oh-uni-package.json` 的 API 版本为 23。编译目标为 `arm64-v8a`，使用静态 C++ 运行库。真实构建发现并修复了公开 SDK 的头文件路径问题；修复后 CMake 构建及链接成功。

```sh
cmake -S native/harmony-recorder -B /tmp/mobile-mcp-recorder-ohos \
  -DCMAKE_TOOLCHAIN_FILE="$OHOS_NDK/build/cmake/ohos.toolchain.cmake" \
  -DOHOS_ARCH=arm64-v8a -DOHOS_STL=c++_static -DCMAKE_BUILD_TYPE=Release
cmake --build /tmp/mobile-mcp-recorder-ohos
```

`file` 确认产物为 64 位 AArch64 ELF PIE，解释器为 `/lib/ld-musl-aarch64.so.1`；`llvm-readelf -d` 确认动态依赖为 `libnative_avscreen_capture.so` 与 `libc.so`。

本次二进制 SHA256：

```text
fe6325d6910904f2b84f92349fe2d46fb90f84d51c8da8d33cd5f6ce6e3375ae
```

本地生成文件位于 `native/harmony-recorder/build/arm64-v8a/`，不纳入源码提交。`build-info.json` 记录源码文件校验值，后续源码变化后应重新构建。二进制包含构建路径信息，其他环境重建不保证得到相同哈希。

## 第二阶段保留项与平台限制

- 定位组件依赖完整平台的内部 `locator_sdk`；公开 Native SDK 没有提供对应库。GN 平台链接及目标产品集成尚未验证，不能用主机状态测试替代。
- 模拟定位的系统身份、MOCK_LOCATION 权限、开发者模式及 USB 条件必须由目标系统允许。普通 shell 身份会被服务拒绝。
- 录屏的系统授权、编码结果逐帧可播放性、设备侧组件部署方式及手机 ABI 兼容性待第二阶段验证。
- 系统剪贴板命令、显示服务开发者命令及故障日志目录是否向商业鸿蒙开放，待手机验证。
- 精确铰链角度、启动时语言覆盖及日志的部分筛选字段仍有明确的平台限制，不能记作全参数对等。

按已确认的阶段边界，第一阶段源码适配、功能对照、模拟验证和分支交付已完成。第二阶段保留项未被这些证据证明，不宣称真机可用或平台权限已经获得。

## 完成核对

| 第一阶段要求 | 当前证据 | 结果 |
|---|---|---|
| 移动工具覆盖与对照 | 从注册代码提取 35 个 mobile 工具名，与功能对照逐项比较，无缺项；其中本地工具具有鸿蒙路径，4 个云工具保留原提供商的 iOS/Android 范围 | 通过 |
| MCP 与设备适配源码 | `src/harmony*.ts`、HDC 执行层、MCP 路由及两组原生组件源码 | 已交付 |
| 中文与失败边界 | Unicode、转义、尾部换行、空值、权限错误、损坏输出、会话清理及恢复测试 | 已验证模拟路径 |
| 构建与检查 | 最新实现提交的 CI Build / Lint 步骤成功 | 通过 |
| 模拟验证 | 本地 249 项测试通过；远端 Unit and protocol tests、两组 Native lifecycle tests 步骤成功 | 通过 |
| 录屏交叉编译 | API 23 SDK 生成 AArch64 ELF；源码和二进制哈希重新核对一致 | 通过 |
| 文档 | 中、英、日 README、逐工具功能对照、组件说明、平台限制和本记录 | 已同步 |
| 交付 | `zhoucanzong/mobile-mcp` 的 `OpenHarmony` 分支；最终文档提交后另行核对远端 HEAD | 分支交付 |

第二阶段应从设备发现、界面读取、中文输入和手势开始，再验证日志、截图、应用管理及受权限约束的功能。系统级定位是否可部署取决于目标系统提供的授权条件，不能把接上普通手机本身当作授权已经满足。
