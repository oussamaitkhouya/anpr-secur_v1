"""Camera connection test: SSRF refusals, real TCP and TLS against local listeners, honest verdict."""

import datetime as dt
import ipaddress
import socket
import ssl
import threading

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from anpr.security import netprobe
from anpr.security.netprobe import ProbeRefused, probe, refusal_reason

LOOPBACK_OK = netprobe.parse_networks(["127.0.0.1/32"])


def fake_resolver(*addrs):
    return lambda _host, _port: list(addrs)


def never_connect(*_args):
    raise AssertionError("the probe must not connect to a refused address")


@pytest.mark.parametrize("addr, reason", [
    ("127.0.0.1", "loopback"),
    ("127.10.0.1", "loopback"),
    ("::1", "loopback"),
    ("::ffff:127.0.0.1", "loopback"),          # IPv4-mapped IPv6 is unwrapped first
    ("169.254.169.254", "metadata"),
    ("169.254.170.2", "metadata"),
    ("100.100.100.200", "metadata"),
    ("fd00:ec2::254", "metadata"),
    ("169.254.10.1", "link-local"),
    ("fe80::1", "link-local"),
    ("224.0.0.1", "multicast"),
    ("0.0.0.0", "unspecified"),
    ("240.0.0.1", "reserved"),
])
def test_refused_addresses(addr, reason):
    assert reason in refusal_reason(addr)


@pytest.mark.parametrize("addr", ["10.20.0.11", "192.168.1.64", "172.16.5.5", "8.8.8.8", "2001:db8::1"])
def test_camera_networks_are_allowed(addr):
    assert refusal_reason(addr) is None


def test_allowlist_opens_a_refused_range_on_purpose():
    assert refusal_reason("127.0.0.1", LOOPBACK_OK) is None
    assert refusal_reason("127.0.0.2", LOOPBACK_OK) == "loopback address"


def test_hostname_resolving_to_metadata_is_refused_before_connecting():
    with pytest.raises(ProbeRefused, match="metadata"):
        probe("rtsp", "metadata.attacker.example", 554, resolver=fake_resolver("169.254.169.254"),
              connector=never_connect)


def test_any_forbidden_answer_refuses_the_whole_name():
    with pytest.raises(ProbeRefused, match="loopback"):
        probe("rtsp", "mixed.example", 554, resolver=fake_resolver("10.0.0.5", "127.0.0.1"), connector=never_connect)


def test_connects_to_the_checked_address_not_a_second_lookup():
    seen = []

    def connector(addr, port, timeout):
        seen.append(addr)
        raise ConnectionRefusedError

    probe("rtsp", "cam.example", 554, resolver=fake_resolver("10.0.0.5"), connector=connector)
    assert seen == ["10.0.0.5"]


@pytest.mark.parametrize("protocol", ["webhook", "file"])
def test_inbound_protocols_are_not_contacted(protocol):
    with pytest.raises(ProbeRefused, match="not contacted"):
        probe(protocol, "10.0.0.5", 80, resolver=never_connect, connector=never_connect)


def test_unresolvable_host_is_unreachable_not_an_error():
    def resolver(_h, _p):
        raise socket.gaierror("no such host")

    result = probe("rtsp", "nope.invalid", 554, resolver=resolver, connector=never_connect)
    assert not result.reachable and result.steps[0].name == "dns" and not result.steps[0].ok


def test_dns_timeout():
    gate = threading.Event()

    def slow(_h, _p):
        gate.wait(2)
        return ["10.0.0.5"]

    result = probe("rtsp", "slow.example", 554, timeout=0.2, resolver=slow, connector=never_connect)
    gate.set()
    assert not result.reachable and "timed out" in result.steps[0].detail


@pytest.fixture
def tcp_listener():
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen()
    yield srv.getsockname()[1]
    srv.close()


def test_real_tcp_connect_reports_reachable_but_stream_not_verified(tcp_listener):
    result = probe("rtsp", "127.0.0.1", tcp_listener, allowed_networks=LOOPBACK_OK)
    assert result.reachable
    assert result.verdict == "Network reachable, stream not verified"
    assert [s.name for s in result.steps] == ["dns", "tcp"]
    assert result.latency_ms is not None and result.latency_ms >= 0


def test_closed_port_is_unreachable():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()  # nothing listens here now
    result = probe("rtsp", "127.0.0.1", port, timeout=1, allowed_networks=LOOPBACK_OK)
    assert not result.reachable and result.verdict == "Unreachable"


def test_loopback_without_allowlist_is_refused(tcp_listener):
    with pytest.raises(ProbeRefused):
        probe("rtsp", "127.0.0.1", tcp_listener)


@pytest.fixture
def tls_listener(tmp_path):
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "camera.test")])
    not_after = dt.datetime(2027, 3, 1, 12, 0, tzinfo=dt.UTC)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(1).not_valid_before(dt.datetime(2026, 1, 1, tzinfo=dt.UTC)).not_valid_after(not_after)
            .sign(key, hashes.SHA256()))
    (tmp_path / "c.pem").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    (tmp_path / "k.pem").write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                                       serialization.NoEncryption()))
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(tmp_path / "c.pem", tmp_path / "k.pem")
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen()

    def serve():
        try:
            conn, _ = srv.accept()
            with ctx.wrap_socket(conn, server_side=True) as tls:
                tls.recv(1)
        except OSError:
            pass

    threading.Thread(target=serve, daemon=True).start()
    yield srv.getsockname()[1], not_after
    srv.close()


def test_rtsps_handshake_captures_certificate_expiry(tls_listener):
    port, not_after = tls_listener
    result = probe("rtsps", "127.0.0.1", port, allowed_networks=LOOPBACK_OK)
    assert result.reachable
    assert [s.name for s in result.steps] == ["dns", "tcp", "tls"]
    assert result.tls_not_after == not_after
    assert "not verified" in result.steps[2].detail


def test_rtsps_against_plain_tcp_fails_the_tls_step(tcp_listener):
    result = probe("rtsps", "127.0.0.1", tcp_listener, timeout=0.5, allowed_networks=LOOPBACK_OK)
    assert not result.reachable and result.steps[-1].name == "tls" and not result.steps[-1].ok


def test_allowlist_parsing():
    nets = netprobe.parse_networks(["10.0.0.0/8", "127.0.0.1"])
    assert ipaddress.ip_address("10.1.2.3") in nets[0]
    assert ipaddress.ip_address("127.0.0.1") in nets[1]
