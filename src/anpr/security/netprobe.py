"""Camera connection test: DNS, TCP connect, TLS handshake. Nothing more.

What it proves, and what it does not:
    reachable  a TCP connection to host:port opened (and, for rtsps, a TLS handshake completed)
    it does NOT prove the stream exists, decodes, or that the credentials work. The result
    says so: "Network reachable, stream not verified".

SSRF defence (the API server makes the connection, so an admin could otherwise aim it at
internal services):
    1. The host is resolved once, here. Every resolved address must pass the policy, and the
       connection goes to the checked address itself, so a second DNS answer cannot redirect it
       (DNS rebinding).
    2. Refused: loopback, link-local (incl. 169.254.169.254 cloud metadata), multicast,
       unspecified and reserved addresses, and known metadata IPs, unless the range is listed in
       ALLOWED_CAMERA_NETWORKS. Private LAN ranges are allowed: that is where cameras live.
    3. Only TCP and TLS. No HTTP, so no redirects to follow and no response body to return.
       Nothing is sent after the handshake; nothing received is returned.
    4. Short timeouts on every step; DNS runs in a worker thread so it can time out too.
    5. Credentials are never used: the probe does not log in.
"""

import ipaddress
import socket
import ssl
import time
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass, field
from datetime import datetime

from cryptography import x509

# Default ports when the camera has none. webhook and file are not reachable from here:
# a webhook camera calls us, and a file source is local to the camera worker.
DEFAULT_PORTS = {"rtsps": 322, "rtsp": 554, "onvif": 80, "mqtt": 1883}
NOT_PROBEABLE = {"webhook", "file"}

METADATA_IPS = frozenset(ipaddress.ip_address(a) for a in (
    "169.254.169.254",   # AWS, GCP, Azure, OpenStack
    "169.254.170.2",     # AWS ECS task metadata
    "100.100.100.200",   # Alibaba Cloud
    "fd00:ec2::254",     # AWS IPv6
))

VERDICT_REACHABLE = "Network reachable, stream not verified"
VERDICT_UNREACHABLE = "Unreachable"

Resolver = Callable[[str, int], list[str]]
Connector = Callable[[str, int, float], socket.socket]

_dns_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="netprobe-dns")


class ProbeRefused(Exception):
    """The target is not allowed by the SSRF policy. The message is safe to show the admin."""


@dataclass
class Step:
    name: str                      # dns | tcp | tls
    ok: bool
    ms: float | None
    detail: str


@dataclass
class ProbeResult:
    reachable: bool
    verdict: str
    latency_ms: float | None
    steps: list[Step] = field(default_factory=list)
    tls_not_after: datetime | None = None


def parse_networks(cidrs: Sequence[str]) -> tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...]:
    return tuple(ipaddress.ip_network(c, strict=False) for c in cidrs)


def refusal_reason(addr: str, allowed: Sequence[ipaddress.IPv4Network | ipaddress.IPv6Network] = ()) -> str | None:
    """Why `addr` may not be contacted, or None if it may."""
    ip = ipaddress.ip_address(addr)
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped  # ::ffff:127.0.0.1 is 127.0.0.1
    if any(ip in net for net in allowed):
        return None
    if ip in METADATA_IPS:
        return "cloud metadata address"
    if ip.is_loopback:
        return "loopback address"
    if ip.is_link_local:
        return "link-local address"
    if ip.is_multicast:
        return "multicast address"
    if ip.is_unspecified:
        return "unspecified address"
    if ip.is_reserved:
        return "reserved address"
    return None


def system_resolver(host: str, port: int) -> list[str]:
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return list(dict.fromkeys(info[4][0] for info in infos))


def system_connector(addr: str, port: int, timeout: float) -> socket.socket:
    return socket.create_connection((addr, port), timeout=timeout)


def _ms(start: float) -> float:
    return round((time.perf_counter() - start) * 1000, 1)


def probe(protocol: str, host: str, port: int | None, *, timeout: float = 3.0,
          allowed_networks: Sequence[ipaddress.IPv4Network | ipaddress.IPv6Network] = (),
          resolver: Resolver = system_resolver, connector: Connector = system_connector) -> ProbeResult:
    """Run DNS -> TCP -> (TLS for rtsps). Raises ProbeRefused before contacting anything forbidden."""
    if protocol in NOT_PROBEABLE:
        raise ProbeRefused(f"{protocol} sources are not contacted by the server; nothing to test")
    port = port or DEFAULT_PORTS.get(protocol)
    if not host or not port:
        raise ProbeRefused("the camera needs a host and a port to be tested")

    steps: list[Step] = []
    start = time.perf_counter()
    try:
        addrs = _dns_pool.submit(resolver, host, port).result(timeout=timeout)
    except FutureTimeout:
        steps.append(Step("dns", False, _ms(start), "DNS lookup timed out"))
        return ProbeResult(False, VERDICT_UNREACHABLE, None, steps)
    except (OSError, UnicodeError):
        steps.append(Step("dns", False, _ms(start), "Host name does not resolve"))
        return ProbeResult(False, VERDICT_UNREACHABLE, None, steps)
    if not addrs:
        steps.append(Step("dns", False, _ms(start), "Host name does not resolve"))
        return ProbeResult(False, VERDICT_UNREACHABLE, None, steps)

    # Every answer must be allowed: a name that resolves to one LAN IP and one loopback IP is refused.
    for addr in addrs:
        reason = refusal_reason(addr, allowed_networks)
        if reason:
            raise ProbeRefused(f"refused: {host} resolves to a {reason}")
    target = addrs[0]
    steps.append(Step("dns", True, _ms(start), f"Resolved to {target}"))

    start = time.perf_counter()
    try:
        sock = connector(target, port, timeout)
    except TimeoutError:
        steps.append(Step("tcp", False, _ms(start), f"No answer on port {port} within {timeout:g} s"))
        return ProbeResult(False, VERDICT_UNREACHABLE, None, steps)
    except OSError:
        steps.append(Step("tcp", False, _ms(start), f"Connection to port {port} refused or unreachable"))
        return ProbeResult(False, VERDICT_UNREACHABLE, None, steps)
    tcp_ms = _ms(start)
    steps.append(Step("tcp", True, tcp_ms, f"Port {port} open"))

    tls_not_after = None
    with sock:
        if protocol == "rtsps":
            start = time.perf_counter()
            # Cameras mostly use self-signed certificates, so the chain is not verified here; the
            # point is to complete a handshake and read the expiry date. The UI says so.
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            try:
                sock.settimeout(timeout)
                with ctx.wrap_socket(sock, server_hostname=host) as tls:
                    der = tls.getpeercert(binary_form=True)
                if der:
                    tls_not_after = x509.load_der_x509_certificate(der).not_valid_after_utc
                detail = "Handshake OK, certificate chain not verified"
                if tls_not_after:
                    detail += f"; expires {tls_not_after:%Y-%m-%d}"
                steps.append(Step("tls", True, _ms(start), detail))
            except (ssl.SSLError, OSError, ValueError):
                steps.append(Step("tls", False, _ms(start), "TLS handshake failed"))
                return ProbeResult(False, VERDICT_UNREACHABLE, tcp_ms, steps)

    return ProbeResult(True, VERDICT_REACHABLE, tcp_ms, steps, tls_not_after)
