#include "session.h"
#include <iostream>
#include <stdexcept>
#include <string>

using namespace mobile_mcp;

class FakeCapture final : public CaptureBackend {
public:
    int initResult = 0, startResult = 0, stopResult = 0;
    int stops = 0, releases = 0;
    bool sendStarted = true, cancel = false;
    EventCallback callback;
    int Initialize(const CaptureConfig&, EventCallback notify) override
    {
        callback = notify;
        return initResult;
    }
    int Start() override
    {
        if (cancel) { callback(CaptureEvent::Canceled, 0); }
        else if (sendStarted) { callback(CaptureEvent::Started, 0); }
        return startResult;
    }
    int Stop() override { stops++; return stopResult; }
    void Release() override { releases++; callback = {}; }
};

void Check(bool value, const char* message)
{
    if (!value) { throw std::runtime_error(message); }
}

int main()
{
    CaptureConfig config{1, 1080, 2400, 2, 5, 1};
    FakeCapture normal;
    int ready = 0;
    Check(Record(normal, config, [] { return false; }, [&] { ready++; }) == 0, "timed recording");
    Check(ready == 1 && normal.stops == 1 && normal.releases == 1, "successful lifecycle");

    FakeCapture canceled;
    canceled.cancel = true;
    ready = 0;
    Check(Record(canceled, config, [] { return false; }, [&] { ready++; }) == -10, "canceled authorization");
    Check(ready == 0 && canceled.releases == 1, "do not announce canceled start");

    FakeCapture pending;
    pending.sendStarted = false;
    Check(Record(pending, config, [] { return false; }, [&] { ready++; }) == -11, "authorization timeout");
    Check(ready == 0 && pending.stops == 1 && pending.releases == 1, "pending cleanup");

    FakeCapture initFailure;
    initFailure.initResult = 9;
    Check(Record(initFailure, config, [] { return false; }, [] {}) == 9, "initialization failure");
    Check(initFailure.stops == 0 && initFailure.releases == 1, "initialization releases resources");

    FakeCapture startFailure;
    startFailure.startResult = 8;
    Check(Record(startFailure, config, [] { return false; }, [&] { ready++; }) == 8, "start failure");
    Check(ready == 0 && startFailure.releases == 1, "no premature success");

    FakeCapture stopFailure;
    stopFailure.stopResult = 7;
    Check(Record(stopFailure, config, [] { return false; }, [] {}) == 7, "finalization failure");

    FakeCapture externalStop;
    Check(Record(externalStop, config, [] { return false; }, [&] {
        externalStop.callback(CaptureEvent::Stopped, 0);
    }) == 0, "system stop");
    Check(externalStop.stops == 0 && externalStop.releases == 1, "no double-stop");

    FakeCapture callbackFailure;
    Check(Record(callbackFailure, config, [] { return false; }, [&] {
        callbackFailure.callback(CaptureEvent::Error, 6);
    }) == 6, "asynchronous error");
    Check(callbackFailure.stops == 1 && callbackFailure.releases == 1, "callback error cleanup");

    FakeCapture manual;
    bool stop = false;
    config.durationMs = 0;
    Check(Record(manual, config, [&] { return stop; }, [&] { stop = true; }) == 0, "manual stop");
    Check(manual.stops == 1 && manual.releases == 1, "manual finalization");
    std::cout << "9 recorder lifecycle scenarios passed\n";
}
