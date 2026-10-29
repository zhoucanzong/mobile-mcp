#include "session.h"
#include <multimedia/player_framework/native_avscreen_capture.h>
#include <charconv>
#include <csignal>
#include <fcntl.h>
#include <iostream>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

using namespace mobile_mcp;

namespace {
volatile std::sig_atomic_t interrupted = 0;
void Interrupt(int) { interrupted = 1; }

class NativeCapture final : public CaptureBackend {
    OH_AVScreenCapture* capture = nullptr;
    EventCallback callback;
    std::string url;

    static void OnState(OH_AVScreenCapture*, OH_AVScreenCaptureStateCode state, void* user)
    {
        auto& self = *static_cast<NativeCapture*>(user);
        switch (state) {
            case OH_SCREEN_CAPTURE_STATE_STARTED:
                self.callback(CaptureEvent::Started, 0); break;
            case OH_SCREEN_CAPTURE_STATE_CANCELED:
                self.callback(CaptureEvent::Canceled, 0); break;
            case OH_SCREEN_CAPTURE_STATE_STOPPED_BY_USER:
            case OH_SCREEN_CAPTURE_STATE_INTERRUPTED_BY_OTHER:
            case OH_SCREEN_CAPTURE_STATE_STOPPED_BY_CALL:
            case OH_SCREEN_CAPTURE_STATE_STOPPED_BY_USER_SWITCHES:
                self.callback(CaptureEvent::Stopped, 0); break;
            default: break;
        }
    }

    static void OnError(OH_AVScreenCapture*, int32_t error, void* user)
    {
        static_cast<NativeCapture*>(user)->callback(CaptureEvent::Error, error);
    }

public:
    int Initialize(const CaptureConfig& settings, EventCallback notify) override
    {
        callback = std::move(notify);
        capture = OH_AVScreenCapture_Create();
        if (!capture) { return -20; }
        int result = OH_AVScreenCapture_SetStateCallback(capture, OnState, this);
        if (result != 0) { return result; }
        result = OH_AVScreenCapture_SetErrorCallback(capture, OnError, this);
        if (result != 0) { return result; }

        OH_AVScreenCaptureConfig config{};
        config.captureMode = OH_CAPTURE_HOME_SCREEN;
        config.dataType = OH_CAPTURE_FILE;
        config.audioInfo.micCapInfo.audioSource = OH_SOURCE_INVALID;
        config.audioInfo.innerCapInfo.audioSource = OH_SOURCE_INVALID;
        config.videoInfo.videoCapInfo.videoFrameWidth = settings.width;
        config.videoInfo.videoCapInfo.videoFrameHeight = settings.height;
        config.videoInfo.videoCapInfo.videoSource = OH_VIDEO_SOURCE_SURFACE_RGBA;
        config.videoInfo.videoEncInfo.videoCodec = OH_H264;
        config.videoInfo.videoEncInfo.videoBitrate = 8000000;
        config.videoInfo.videoEncInfo.videoFrameRate = 30;
        url = "fd://" + std::to_string(settings.fd);
        config.recorderInfo.url = url.data();
        config.recorderInfo.urlLen = static_cast<uint32_t>(url.size());
        config.recorderInfo.fileFormat = CFT_MPEG_4;
        result = OH_AVScreenCapture_Init(capture, config);
        if (result != 0) { return result; }
        return OH_AVScreenCapture_SetMicrophoneEnabled(capture, false);
    }

    int Start() override { return OH_AVScreenCapture_StartScreenRecording(capture); }
    int Stop() override { return OH_AVScreenCapture_StopScreenRecording(capture); }
    void Release() override
    {
        if (capture) {
            OH_AVScreenCapture_Release(capture);
            capture = nullptr;
        }
    }
};

bool ParseInteger(const char* text, int& value)
{
    std::string input(text);
    const auto result = std::from_chars(input.data(), input.data() + input.size(), value);
    return result.ec == std::errc{} && result.ptr == input.data() + input.size();
}
} // namespace

int main(int argc, char** argv)
{
    // Arguments: output.mp4 stop-file width height duration-seconds (0 = until stopped).
    int width, height, duration;
    if (argc != 6 || !ParseInteger(argv[3], width) || !ParseInteger(argv[4], height) ||
        !ParseInteger(argv[5], duration) || width < 2 || height < 2 || width > 16384 ||
        height > 16384 || width % 2 || height % 2 || duration < 0 || duration > 86400 ||
        std::string(argv[1]) == argv[2]) {
        std::cerr << "Expected output.mp4 stop-file even-width even-height duration-seconds(0..86400)\n";
        return 2;
    }

    const int fd = open(argv[1], O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    if (fd < 0) {
        std::cout << "{\"event\":\"error\",\"code\":-21}" << std::endl;
        return 1;
    }
    std::signal(SIGINT, Interrupt);
    std::signal(SIGTERM, Interrupt);
    std::signal(SIGHUP, Interrupt);
    std::signal(SIGPIPE, SIG_IGN);
    const auto parent = getppid();
    NativeCapture backend;
    CaptureConfig config{fd, width, height, duration * 1000};
    const int result = Record(backend, config, [&] {
        struct stat control{};
        return interrupted || getppid() != parent || !std::cout.good() || lstat(argv[2], &control) == 0;
    }, [] {
        std::cout << "{\"event\":\"started\",\"pid\":" << getpid() << "}" << std::endl;
    });
    struct stat output{};
    const bool saved = result == 0 && fsync(fd) == 0 && fstat(fd, &output) == 0 && output.st_size > 0;
    close(fd);
    if (!saved) {
        std::cout << "{\"event\":\"error\",\"code\":" << (result == 0 ? -22 : result) << "}" << std::endl;
        return 1;
    }
    std::cout << "{\"event\":\"stopped\",\"bytes\":" << output.st_size << "}" << std::endl;
    return 0;
}
