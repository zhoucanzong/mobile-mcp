# 模拟定位组件

设备端组件调用平台 Locator SDK 的模拟定位接口，持续报告固定坐标，显式清除时关闭模拟定位。已实现设备端源码、主机状态测试与 MCP 持续会话管理。设置 HARMONY_LOCATION_COMMAND 为设备侧授权组件后使用；设备端完整平台构建仍未验证。

## 系统条件

系统检查开发者模式、USB 连接、系统调用身份及 `ohos.permission.MOCK_LOCATION`。回读还需要相应定位访问权限。源码明确拒绝普通 shell token 的系统身份检查，所以不能假定将二进制放进 `/data/local/tmp` 后由 HDC 启动即可获得权限。

本组件不申请伪造 token、不修改权限策略，也不自动提升权限。部署必须由目标产品提供合法的原生/CLI 工具身份或其他被系统允许的承载方式。商业鸿蒙是否提供这种授权方式，需要第二阶段确认。

## 构建

该组件使用平台内部的 `locator_sdk`，不是仅靠公开应用 NDK 即可链接的程序。`BUILD.gn` 是完整 OpenHarmony 平台源码树中的构建入口：将目录集成到平台产品，配置目标的调用身份与权限后构建 `mobile-mcp-location`。当前未执行完整平台链接，不声明已生成可在手机上运行的二进制。

主机状态测试不依赖定位服务：

```sh
cmake -S native/harmony-location -B /tmp/mobile-mcp-location-tests
cmake --build /tmp/mobile-mcp-location-tests
ctest --test-dir /tmp/mobile-mcp-location-tests --output-on-failure
```

模拟测试覆盖持续发布、权限拒绝、发布失败回滚、坐标/模拟标志不匹配、回读失败、运行中失败、清理失败及无效坐标。不会改变电脑或手机位置。

## 执行协议

```text
mobile-mcp-location run latitude longitude stop-file
mobile-mcp-location clear
```

- 经纬度必须是有限数值，纬度范围 -90 到 90，经度 -180 到 180。
- 成功启用后发送坐标，并最多等待 5 秒确认缓存位置与目标一致且带模拟标志，之后才输出 `started` 事件。
- 确认后每秒重新发送一次坐标，避免单次坐标队列消费完后停止提供更新。
- 停止文件出现、收到终止信号、父进程变化或发生运行错误时关闭模拟定位。
- 发布停止并执行关闭后，会在 stop-file 后附加 `.done` 的路径写入终止结果，供 HDC 输出丢失时核对；记录不能解析时不得视为确认终止。
- 正常完成输出 `{"event":"cleared","code":0}`；失败输出 `error`，包含原始 `code` 和清理 `clearCode`。清理失败不能宣称真实定位已恢复。
- `clear` 单独执行关闭操作，可用于恢复；关闭后系统何时产生新的真实定位结果不由本工具保证。

接口与权限依据：[LocatorImpl](https://github.com/openharmony/base_location/blob/4c5dca7cf9faeae4da0ba833945770600129e2dc/interfaces/inner_api/include/locator_impl.h)、[模拟定位服务检查](https://github.com/openharmony/base_location/blob/4c5dca7cf9faeae4da0ba833945770600129e2dc/services/location_locator/locator/source/locator_ability.cpp#L1452)、[系统身份和权限判断](https://github.com/openharmony/base_location/blob/4c5dca7cf9faeae4da0ba833945770600129e2dc/frameworks/location_common/common/source/permission_manager.cpp#L115)。
