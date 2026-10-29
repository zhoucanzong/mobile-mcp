#pragma once

#include <atomic>
#include <chrono>
#include <functional>
#include <thread>

namespace mobile_mcp {

enum class CaptureEvent { Started, Stopped, Canceled, Error };
using EventCallback = std::function<void(CaptureEvent, int)>;

struct CaptureConfig {
    int fd;
    int width;
    int height;
    int durationMs = 0;
    int authorizationTimeoutMs = 60000;
    int pollMs = 50;
};

class CaptureBackend {
public:
    virtual ~CaptureBackend() = default;
    virtual int Initialize(const CaptureConfig&, EventCallback) = 0;
    virtual int Start() = 0;
    virtual int Stop() = 0;
    // Release must finish callbacks before returning.
    virtual void Release() = 0;
};

// This lifecycle is shared by the native executable and deterministic host tests.
inline int Record(CaptureBackend& backend, const CaptureConfig& config,
                  const std::function<bool()>& stopRequested,
                  const std::function<void()>& reportStarted)
{
    std::atomic<bool> started{false};
    std::atomic<bool> ended{false};
    std::atomic<int> failure{0};
    struct ReleaseGuard {
        CaptureBackend& backend;
        ~ReleaseGuard() { backend.Release(); }
    } guard{backend};

    int result = backend.Initialize(config, [&](CaptureEvent event, int code) {
        switch (event) {
            case CaptureEvent::Started: started = true; break;
            case CaptureEvent::Stopped: ended = true; break;
            case CaptureEvent::Canceled: failure = -10; break;
            case CaptureEvent::Error: failure = code == 0 ? -13 : code; break;
        }
    });
    if (result != 0) {
        return result;
    }
    result = backend.Start();
    if (result != 0) {
        return result;
    }

    const auto requestedAt = std::chrono::steady_clock::now();
    auto elapsed = [](auto since) {
        return std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - since).count();
    };
    while (!started && !ended && failure == 0 && !stopRequested() &&
           elapsed(requestedAt) < config.authorizationTimeoutMs) {
        std::this_thread::sleep_for(std::chrono::milliseconds(config.pollMs));
    }
    if (!started || failure != 0 || ended || stopRequested()) {
        if (!ended) {
            backend.Stop();
        }
        return failure != 0 ? failure.load() : (!started ? -11 : -12);
    }

    reportStarted();
    const auto startedAt = std::chrono::steady_clock::now();
    while (!ended && failure == 0 && !stopRequested() &&
           (config.durationMs == 0 || elapsed(startedAt) < config.durationMs)) {
        std::this_thread::sleep_for(std::chrono::milliseconds(config.pollMs));
    }

    // A terminal system callback already stopped capture. Do not call Stop twice.
    result = ended ? 0 : backend.Stop();
    return failure != 0 ? failure.load() : result;
}

} // namespace mobile_mcp
