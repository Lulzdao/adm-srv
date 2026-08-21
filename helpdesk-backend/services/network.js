function ipToInt(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function cidrContains(cidr, ip) {
  if (!cidr || !ip) return false;
  const [range, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  const rangeInt = ipToInt(range);
  const ipInt = ipToInt(ip);
  if (rangeInt === null || ipInt === null || Number.isNaN(bits)) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (rangeInt & mask) === (ipInt & mask);
}

// Express отдаёт IPv4-адреса за IPv6-туннелем как "::ffff:10.1.2.3".
function normalizeIp(raw) {
  if (!raw) return raw;
  if (raw.startsWith("::ffff:")) return raw.slice(7);
  if (raw === "::1") return "127.0.0.1";
  return raw;
}

function detectDomain(rawIp, config) {
  const ip = normalizeIp(rawIp);
  if (config.network.domainACidr && cidrContains(config.network.domainACidr, ip)) return "A";
  if (config.network.domainBCidr && cidrContains(config.network.domainBCidr, ip)) return "B";
  return null;
}

module.exports = { cidrContains, normalizeIp, detectDomain };
