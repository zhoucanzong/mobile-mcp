#pragma once

#include <chrono>
#include <cmath>
#include <functional>
#include <thread>

namespace mobile_mcp {

class LocationBackend {
public:
    virtual ~LocationBackend() = default;
    virtual int Enable() = 0;
    virtual int Publish(double latitude, double longitude) = 0;
    virtual int Read(double& latitude, double& longitude, bool& fromMock) = 0;
    virtual int Disable() = 0;
};

struct LocationOutcome { int code; int clearCode; };
struct LocationTiming { int verifyMs = 5000; int publishMs = 1000; int pollMs = 100; };

inline bool ValidCoordinates(double latitude, double longitude)
{
    return std::isfinite(latitude) && std::isfinite(longitude) &&
        latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}

inline LocationOutcome RunLocationMock(LocationBackend& backend, double latitude, double longitude,
    const std::function<bool()>& stopRequested, const std::function<void()>& confirmed,
    LocationTiming timing = {})
{
    if (!ValidCoordinates(latitude, longitude)) { return {-30, 0}; }
    int code = backend.Enable();
    if (code != 0) { return {code, 0}; }
    bool cleared = false;
    struct Guard {
        LocationBackend& backend;
        bool& cleared;
        ~Guard() { if (!cleared) { backend.Disable(); } }
    } guard{backend, cleared};
    auto finish = [&](int result) {
        int cleanup = backend.Disable();
        cleared = true;
        return LocationOutcome{result, cleanup};
    };
    code = backend.Publish(latitude, longitude);
    if (code != 0) { return finish(code); }

    const auto requestedAt = std::chrono::steady_clock::now();
    auto elapsed = [](auto since) {
        return std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - since).count();
    };
    bool verified = false;
    while (!stopRequested() && elapsed(requestedAt) < timing.verifyMs) {
        double observedLatitude = 0, observedLongitude = 0;
        bool fromMock = false;
        code = backend.Read(observedLatitude, observedLongitude, fromMock);
        if (code == 0 && fromMock && std::abs(observedLatitude - latitude) <= 0.000001 &&
            std::abs(observedLongitude - longitude) <= 0.000001) {
            verified = true;
            break;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(timing.pollMs));
    }
    if (!verified) { return finish(code == 0 ? -31 : code); }

    confirmed();
    auto lastPublished = std::chrono::steady_clock::now();
    while (!stopRequested()) {
        if (elapsed(lastPublished) >= timing.publishMs) {
            code = backend.Publish(latitude, longitude);
            if (code != 0) { return finish(code); }
            lastPublished = std::chrono::steady_clock::now();
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(timing.pollMs));
    }
    return finish(0);
}

} // namespace mobile_mcp
