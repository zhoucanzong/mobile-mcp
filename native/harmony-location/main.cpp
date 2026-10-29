#include "session.h"
#include "locator_impl.h"
#include "location.h"
#include <csignal>
#include <fcntl.h>
#include <iomanip>
#include <iostream>
#include <memory>
#include <string>
#include <sstream>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>

using namespace mobile_mcp;

namespace {
volatile std::sig_atomic_t interrupted = 0;
void Interrupt(int) { interrupted = 1; }

class NativeLocation final : public LocationBackend {
    std::shared_ptr<OHOS::Location::LocatorImpl> locator = OHOS::Location::LocatorImpl::GetInstance();
public:
    int Enable() override { return locator ? locator->EnableLocationMockV9() : -32; }
    int Disable() override { return locator ? locator->DisableLocationMockV9() : -32; }
    int Publish(double latitude, double longitude) override
    {
        if (!locator) { return -32; }
        auto location = std::make_shared<OHOS::Location::Location>();
        location->SetLatitude(latitude);
        location->SetLongitude(longitude);
        location->SetAccuracy(1.0);
        location->SetIsFromMock(1);
        return locator->SetMockedLocationsV9(0, {location});
    }
    int Read(double& latitude, double& longitude, bool& fromMock) override
    {
        if (!locator) { return -32; }
        std::unique_ptr<OHOS::Location::Location> value;
        int result = locator->GetCachedLocationV9(value);
        if (result != 0) { return result; }
        if (!value) { return -33; }
        latitude = value->GetLatitude();
        longitude = value->GetLongitude();
        fromMock = value->GetIsFromMock() != 0;
        return 0;
    }
};

bool ParseCoordinate(const char* argument, double& value)
{
    try {
        std::string input(argument);
        size_t consumed = 0;
        value = std::stod(input, &consumed);
        return consumed == input.size() && std::isfinite(value);
    } catch (...) { return false; }
}
} // namespace

int main(int argc, char** argv)
{
    NativeLocation backend;
    if (argc == 2 && std::string(argv[1]) == "clear") {
        int code = backend.Disable();
        std::cout << "{\"event\":\"" << (code == 0 ? "cleared" : "error")
                  << "\",\"code\":" << code << "}" << std::endl;
        return code == 0 ? 0 : 1;
    }
    double latitude, longitude;
    if (argc != 5 || std::string(argv[1]) != "run" ||
        !ParseCoordinate(argv[2], latitude) || !ParseCoordinate(argv[3], longitude) ||
        !ValidCoordinates(latitude, longitude)) {
        std::cerr << "Expected: run latitude longitude stop-file; or clear\n";
        return 2;
    }
    std::signal(SIGINT, Interrupt);
    std::signal(SIGTERM, Interrupt);
    std::signal(SIGHUP, Interrupt);
    std::signal(SIGPIPE, SIG_IGN);
    const auto parent = getppid();
    auto outcome = RunLocationMock(backend, latitude, longitude, [&] {
        struct stat control{};
        return interrupted || getppid() != parent || !std::cout.good() || lstat(argv[4], &control) == 0;
    }, [&] {
        std::cout << std::setprecision(17) << "{\"event\":\"started\",\"latitude\":"
                  << latitude << ",\"longitude\":" << longitude << "}" << std::endl;
    });
    std::ostringstream terminal;
    if (outcome.code != 0 || outcome.clearCode != 0) {
        terminal << "{\"event\":\"error\",\"code\":" << outcome.code
                 << ",\"clearCode\":" << outcome.clearCode << "}";
    } else {
        terminal << "{\"event\":\"cleared\",\"code\":0}";
    }
    // Terminal receipt is written only after the publisher has stopped. It
    // lets the host recover when the HDC output channel disappeared.
    const std::string receipt = std::string(argv[4]) + ".done";
    int fd = open(receipt.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    if (fd >= 0) {
        const auto data = terminal.str();
        size_t offset = 0;
        while (offset < data.size()) {
            auto count = write(fd, data.data() + offset, data.size() - offset);
            if (count <= 0) { break; }
            offset += static_cast<size_t>(count);
        }
        fsync(fd);
        close(fd);
    }
    std::cout << terminal.str() << std::endl;
    return outcome.code == 0 && outcome.clearCode == 0 ? 0 : 1;
}
