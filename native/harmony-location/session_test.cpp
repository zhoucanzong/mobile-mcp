#include "session.h"
#include <iostream>
#include <limits>
#include <stdexcept>

using namespace mobile_mcp;

class FakeLocation final : public LocationBackend {
public:
    int enableCode = 0, publishCode = 0, readCode = 0, clearCode = 0;
    int enables = 0, publishes = 0, clears = 0;
    double latitude = 0, longitude = 0;
    bool fromMock = true, wrongCoordinates = false;
    int failAfter = 0;
    int Enable() override { enables++; return enableCode; }
    int Publish(double lat, double lon) override
    {
        publishes++;
        latitude = lat; longitude = lon;
        return failAfter && publishes >= failAfter ? 77 : publishCode;
    }
    int Read(double& lat, double& lon, bool& mock) override
    {
        lat = wrongCoordinates ? 0 : latitude;
        lon = longitude; mock = fromMock;
        return readCode;
    }
    int Disable() override { clears++; return clearCode; }
};

void Check(bool value, const char* message)
{
    if (!value) { throw std::runtime_error(message); }
}

int main()
{
    LocationTiming fast{5, 1, 1};
    FakeLocation normal;
    int ready = 0;
    auto result = RunLocationMock(normal, 31.2, 121.5, [&] { return normal.publishes >= 3; }, [&] { ready++; }, fast);
    Check(result.code == 0 && result.clearCode == 0 && ready == 1 && normal.clears == 1, "persistent publish and clear");

    FakeLocation denied;
    denied.enableCode = 201;
    result = RunLocationMock(denied, 0, 0, [] { return false; }, [] {}, fast);
    Check(result.code == 201 && denied.clears == 0 && denied.publishes == 0, "permission failure must not change mock state");

    FakeLocation publish;
    publish.publishCode = 202;
    result = RunLocationMock(publish, 1, 2, [] { return false; }, [] {}, fast);
    Check(result.code == 202 && publish.clears == 1, "publish rollback");

    for (bool mock : {true, false}) {
        FakeLocation unverified;
        unverified.fromMock = mock;
        unverified.wrongCoordinates = mock;
        ready = 0;
        result = RunLocationMock(unverified, 1, 2, [] { return false; }, [&] { ready++; }, fast);
        Check(result.code == -31 && ready == 0 && unverified.clears == 1, "require matching mock readback");
    }

    FakeLocation readDenied;
    readDenied.readCode = 203;
    result = RunLocationMock(readDenied, 1, 2, [] { return false; }, [] {}, fast);
    Check(result.code == 203 && readDenied.clears == 1, "readback permission rollback");

    FakeLocation lost;
    lost.failAfter = 2;
    result = RunLocationMock(lost, 1, 2, [] { return false; }, [] {}, fast);
    Check(result.code == 77 && lost.clears == 1, "runtime failure cleanup");

    FakeLocation clearDenied;
    clearDenied.clearCode = 204;
    bool stop = false;
    result = RunLocationMock(clearDenied, 1, 2, [&] { return stop; }, [&] { stop = true; }, fast);
    Check(result.clearCode == 204, "report failed cleanup");

    FakeLocation invalid;
    result = RunLocationMock(invalid, std::numeric_limits<double>::quiet_NaN(), 0, [] { return false; }, [] {}, fast);
    Check(result.code == -30 && invalid.enables == 0, "reject invalid coordinates before enable");
    Check(!ValidCoordinates(91, 0) && !ValidCoordinates(0, 181) && ValidCoordinates(-90, 180), "coordinate boundaries");
    std::cout << "9 location lifecycle scenarios passed\n";
}
