/* AstraDVB, GPL-2.0-only. Optional, socket-scoped Linux TCP controls.
 * No sysctl/module changes, process inspection, URLs, credentials or CAS I/O. */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <errno.h>
#include <limits.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <sys/socket.h>
#include <netinet/in.h>
#ifdef __linux__
#include <linux/tcp.h>
#endif

#ifndef MEDIA_TCP_GETSOCKOPT
#define MEDIA_TCP_GETSOCKOPT getsockopt
#endif
#ifndef MEDIA_TCP_SETSOCKOPT
#define MEDIA_TCP_SETSOCKOPT setsockopt
#endif

enum { MEDIA_TCP_PACING = 1, MEDIA_TCP_DELIVERY = 2, MEDIA_TCP_ACKED = 4,
       MEDIA_TCP_SENT = 8, MEDIA_TCP_RETRANS_BYTES = 16, MEDIA_TCP_NOT_SENT = 32 };
struct media_tcp_result {
    char algorithm[32], previous[32];
    const char *reason;
    int error, info_available, changed, restore_failed;
    unsigned int optional_fields;
    uint32_t state, rtt_us, rtt_var_us, retransmits, total_retransmits;
    uint32_t unacked, lost, snd_cwnd, snd_mss, rcv_mss, rcv_space, not_sent;
    uint64_t pacing_rate, delivery_rate, bytes_acked, bytes_sent, bytes_retrans;
};

static int media_tcp_scope(int fd, unsigned int expected_port) {
    int type = 0, listener = 0;
    socklen_t size = sizeof(type);
    struct sockaddr_storage local, peer;
    if (fd < 0 || !expected_port || expected_port > 65535) return EINVAL;
    if (MEDIA_TCP_GETSOCKOPT(fd, SOL_SOCKET, SO_TYPE, &type, &size) < 0) return errno;
    if (type != SOCK_STREAM) return EPROTOTYPE;
    size = sizeof(listener);
    if (MEDIA_TCP_GETSOCKOPT(fd, SOL_SOCKET, SO_ACCEPTCONN, &listener, &size) < 0) return errno;
    if (listener) return EACCES;
    size = sizeof(local);
    if (getsockname(fd, (struct sockaddr *)&local, &size) < 0) return errno;
    unsigned int port;
    if (local.ss_family == AF_INET) port = ntohs(((struct sockaddr_in *)&local)->sin_port);
    else if (local.ss_family == AF_INET6) port = ntohs(((struct sockaddr_in6 *)&local)->sin6_port);
    else return EPROTOTYPE;
    if (port != expected_port) return EACCES;
    size = sizeof(peer);
    if (getpeername(fd, (struct sockaddr *)&peer, &size) < 0) return errno;
    if (peer.ss_family != AF_INET && peer.ss_family != AF_INET6) return EPROTOTYPE;
#ifdef __linux__
    int protocol = 0;
    size = sizeof(protocol);
    if (MEDIA_TCP_GETSOCKOPT(fd, SOL_SOCKET, SO_PROTOCOL, &protocol, &size) < 0) return errno;
    if (protocol != IPPROTO_TCP) return EPROTOTYPE;
#endif
    return 0;
}

static int media_tcp_read(int fd, struct media_tcp_result *result) {
    result->info_available = 0; result->optional_fields = 0;
#ifdef __linux__
    socklen_t size = sizeof(result->algorithm);
    if (MEDIA_TCP_GETSOCKOPT(fd, IPPROTO_TCP, TCP_CONGESTION, result->algorithm, &size) < 0) return errno;
    result->algorithm[sizeof(result->algorithm) - 1] = 0;
    struct tcp_info info;
    memset(&info, 0, sizeof(info)); size = sizeof(info);
    if (MEDIA_TCP_GETSOCKOPT(fd, IPPROTO_TCP, TCP_INFO, &info, &size) < 0 ||
        size < offsetof(struct tcp_info, tcpi_total_retrans) + sizeof(info.tcpi_total_retrans)) return 0;
    result->info_available = 1;
    result->state = info.tcpi_state; result->rtt_us = info.tcpi_rtt; result->rtt_var_us = info.tcpi_rttvar;
    result->retransmits = info.tcpi_retrans; result->total_retransmits = info.tcpi_total_retrans;
    result->unacked = info.tcpi_unacked; result->lost = info.tcpi_lost;
    result->snd_cwnd = info.tcpi_snd_cwnd; result->snd_mss = info.tcpi_snd_mss;
    result->rcv_mss = info.tcpi_rcv_mss; result->rcv_space = info.tcpi_rcv_space;
#define MEDIA_TCP_COPY(field, target, flag) do { \
    if (size >= offsetof(struct tcp_info, field) + sizeof(info.field)) { \
        result->target = info.field; result->optional_fields |= flag; \
    } \
} while (0)
    MEDIA_TCP_COPY(tcpi_pacing_rate, pacing_rate, MEDIA_TCP_PACING);
    MEDIA_TCP_COPY(tcpi_delivery_rate, delivery_rate, MEDIA_TCP_DELIVERY);
    MEDIA_TCP_COPY(tcpi_bytes_acked, bytes_acked, MEDIA_TCP_ACKED);
    MEDIA_TCP_COPY(tcpi_bytes_sent, bytes_sent, MEDIA_TCP_SENT);
    MEDIA_TCP_COPY(tcpi_bytes_retrans, bytes_retrans, MEDIA_TCP_RETRANS_BYTES);
    MEDIA_TCP_COPY(tcpi_notsent_bytes, not_sent, MEDIA_TCP_NOT_SENT);
#undef MEDIA_TCP_COPY
    return 0;
#else
    (void)fd; (void)result; return ENOTSUP;
#endif
}

static int media_tcp_inspect(int fd, unsigned int expected_port, struct media_tcp_result *result) {
    memset(result, 0, sizeof(*result));
    int error = media_tcp_scope(fd, expected_port);
    if (error) { result->reason = "socket_scope"; return result->error = error; }
    error = media_tcp_read(fd, result);
    if (error) result->reason = error == ENOTSUP ? "unsupported_platform" : "kernel_query_failed";
    else memcpy(result->previous, result->algorithm, sizeof(result->previous));
    return result->error = error;
}

static int media_tcp_algorithm(const char *algorithm) {
    return algorithm && (!strcmp(algorithm, "bbr") || !strcmp(algorithm, "cubic") || !strcmp(algorithm, "reno"));
}

static int media_tcp_configure(int fd, unsigned int expected_port, const char *algorithm, struct media_tcp_result *result) {
    memset(result, 0, sizeof(*result));
    if (!media_tcp_algorithm(algorithm)) {
        result->reason = "invalid_argument"; return result->error = EINVAL;
    }
    int error = media_tcp_scope(fd, expected_port);
    if (error) { result->reason = "socket_scope"; return result->error = error; }
    error = media_tcp_read(fd, result);
    if (error) { result->reason = error == ENOTSUP ? "unsupported_platform" : "kernel_query_failed"; return result->error = error; }
    memcpy(result->previous, result->algorithm, sizeof(result->previous));
    if (!strcmp(result->algorithm, algorithm)) return 0;
    if (!media_tcp_algorithm(result->previous)) { result->reason = "unsupported_baseline"; return result->error = ENOTSUP; }
#ifdef __linux__
    if (MEDIA_TCP_SETSOCKOPT(fd, IPPROTO_TCP, TCP_CONGESTION, algorithm, (socklen_t)strlen(algorithm)) < 0) {
        result->reason = "kernel_rejected"; return result->error = errno;
    }
    result->changed = 1;
    error = media_tcp_read(fd, result);
    if (!error && strcmp(result->algorithm, algorithm)) error = EIO;
    if (!error) return 0;
    /* A successful set followed by failed verification is not an ordinary
     * unsupported-kernel fallback. Restore and prove the previous selection,
     * or tell the HTTP owner to close this connection before further use. */
    int restore_error = media_tcp_scope(fd, expected_port);
    if (!restore_error && MEDIA_TCP_SETSOCKOPT(fd, IPPROTO_TCP, TCP_CONGESTION, result->previous, (socklen_t)strlen(result->previous)) < 0) restore_error = errno;
    if (!restore_error) restore_error = media_tcp_read(fd, result);
    if (!restore_error && strcmp(result->algorithm, result->previous)) restore_error = EIO;
    if (restore_error) {
        result->restore_failed = 1; result->info_available = 0; result->algorithm[0] = 0;
        result->reason = "restore_failed"; return result->error = restore_error;
    }
    result->changed = 0; result->reason = "kernel_query_failed"; return result->error = error;
#else
    result->reason = "unsupported_platform"; return result->error = ENOTSUP;
#endif
}

#ifndef ASTRA_MEDIA_TCP_TEST
#include <node_api.h>

static const char *media_tcp_error_name(int error) {
    switch (error) {
    case 0: return NULL;
    case EINVAL: return "EINVAL";
    case EIO: return "EIO";
    case EBADF: return "EBADF";
    case ENOTSOCK: return "ENOTSOCK";
    case ENOTCONN: return "ENOTCONN";
    case EACCES: return "EACCES";
    case EPERM: return "EPERM";
    case ENOENT: return "ENOENT";
    case EPROTOTYPE: return "EPROTOTYPE";
    case ENOPROTOOPT: return "ENOPROTOOPT";
    case ENOTSUP: return "ENOTSUP";
    default: return "TCP_ERROR";
    }
}
static void media_tcp_number(napi_env env, napi_value object, const char *key, double number) {
    napi_value value; napi_create_double(env, number, &value); napi_set_named_property(env, object, key, value);
}
static void media_tcp_string(napi_env env, napi_value object, const char *key, const char *text) {
    napi_value value;
    if (text) napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &value); else napi_get_null(env, &value);
    napi_set_named_property(env, object, key, value);
}
static napi_value media_tcp_result_value(napi_env env, const struct media_tcp_result *result) {
    napi_value object, value, info;
    napi_create_object(env, &object); napi_get_boolean(env, result->error == 0, &value);
    napi_set_named_property(env, object, "ok", value);
    napi_get_boolean(env, result->changed != 0, &value); napi_set_named_property(env, object, "changed", value);
    napi_get_boolean(env, result->restore_failed != 0, &value); napi_set_named_property(env, object, "restoreFailed", value);
    media_tcp_string(env, object, "algorithm", result->algorithm[0] ? result->algorithm : NULL);
    media_tcp_string(env, object, "previousAlgorithm", result->previous[0] ? result->previous : NULL);
    media_tcp_string(env, object, "reason", result->reason);
    media_tcp_string(env, object, "code", media_tcp_error_name(result->error));
    if (result->info_available) {
        napi_create_object(env, &info);
        media_tcp_number(env, info, "state", result->state);
        media_tcp_number(env, info, "rttUs", result->rtt_us);
        media_tcp_number(env, info, "rttVarianceUs", result->rtt_var_us);
        media_tcp_number(env, info, "unackedPackets", result->unacked);
        media_tcp_number(env, info, "lostPackets", result->lost);
        media_tcp_number(env, info, "retransmittedPackets", result->retransmits);
        media_tcp_number(env, info, "totalRetransmissions", result->total_retransmits);
        media_tcp_number(env, info, "congestionWindowPackets", result->snd_cwnd);
        media_tcp_number(env, info, "sendMssBytes", result->snd_mss);
        media_tcp_number(env, info, "receiveMssBytes", result->rcv_mss);
        media_tcp_number(env, info, "receiveSpaceBytes", result->rcv_space);
        if (result->optional_fields & MEDIA_TCP_PACING) media_tcp_number(env, info, "pacingRateBytesPerSecond", (double)result->pacing_rate);
        if (result->optional_fields & MEDIA_TCP_DELIVERY) media_tcp_number(env, info, "deliveryRateBytesPerSecond", (double)result->delivery_rate);
        if (result->optional_fields & MEDIA_TCP_ACKED) media_tcp_number(env, info, "bytesAcknowledged", (double)result->bytes_acked);
        if (result->optional_fields & MEDIA_TCP_SENT) media_tcp_number(env, info, "bytesSent", (double)result->bytes_sent);
        if (result->optional_fields & MEDIA_TCP_RETRANS_BYTES) media_tcp_number(env, info, "bytesRetransmitted", (double)result->bytes_retrans);
        if (result->optional_fields & MEDIA_TCP_NOT_SENT) media_tcp_number(env, info, "notSentBytes", result->not_sent);
    } else napi_get_null(env, &info);
    napi_set_named_property(env, object, "info", info); return object;
}
static int media_tcp_integer(napi_env env, napi_value value, unsigned int maximum, unsigned int *number) {
    double result;
    if (napi_get_value_double(env, value, &result) != napi_ok || !(result >= 0 && result <= maximum)) return 0;
    *number = (unsigned int)result; return result == (double)*number;
}
static napi_value media_tcp_call(napi_env env, napi_callback_info callback, int configure) {
    napi_value args[3]; size_t count = 3;
    struct media_tcp_result result; memset(&result, 0, sizeof(result));
    unsigned int fd = 0, port = 0; char algorithm[16]; size_t length = 0, written = 0;
    if (napi_get_cb_info(env, callback, &count, args, NULL, NULL) != napi_ok || count < (size_t)(configure ? 3 : 2) ||
        !media_tcp_integer(env, args[0], INT_MAX, &fd) || !media_tcp_integer(env, args[1], 65535, &port) || !port ||
        (configure && (napi_get_value_string_utf8(env, args[2], NULL, 0, &length) != napi_ok || !length || length >= sizeof(algorithm) ||
                       napi_get_value_string_utf8(env, args[2], algorithm, sizeof(algorithm), &written) != napi_ok || written != length || strlen(algorithm) != length))) {
        result.error = EINVAL; result.reason = "invalid_argument";
    } else if (configure) media_tcp_configure((int)fd, port, algorithm, &result);
    else media_tcp_inspect((int)fd, port, &result);
    return media_tcp_result_value(env, &result);
}
static napi_value media_tcp_configure_js(napi_env env, napi_callback_info callback) { return media_tcp_call(env, callback, 1); }
static napi_value media_tcp_inspect_js(napi_env env, napi_callback_info callback) { return media_tcp_call(env, callback, 0); }
static napi_value media_tcp_init(napi_env env, napi_value exports) {
    const napi_property_descriptor properties[] = {
        {"configure", NULL, media_tcp_configure_js, NULL, NULL, NULL, napi_default, NULL},
        {"inspect", NULL, media_tcp_inspect_js, NULL, NULL, NULL, napi_default, NULL}
    };
    napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties); return exports;
}
NAPI_MODULE(astra_media_tcp, media_tcp_init)
#endif
