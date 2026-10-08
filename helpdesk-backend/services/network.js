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

// У домена не одна подсеть, а список: через запятую, пробел или точку с запятой.
// Отдельный адрес пишется без маски (10.148.130.87 — то же, что /32).
//
// Список понадобился из-за прокси: клиент за ним приходит не со своего адреса,
// а с адреса прокси, и тот может лежать вне подсети домена — даже в чужой.
// Настоящий адрес клиента до нас при этом не доходит вовсе, поэтому
// единственный способ — записать адрес прокси тому домену, чьи клиенты через
// него ходят.
function parseCidrList(value) {
  return String(value || "")
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map((item) => (item.includes("/") ? item : `${item}/32`));
}

// Длина маски самой узкой записи списка, в которую попал адрес; -1 — ни в одну.
function bestMatch(list, ip) {
  let best = -1;
  for (const cidr of parseCidrList(list)) {
    const bits = Number(cidr.split("/")[1]);
    if (bits > best && cidrContains(cidr, ip)) best = bits;
  }
  return best;
}

// Побеждает самая узкая запись, а не первый по порядку домен: адрес прокси,
// записанный одному домену, должен пересилить широкую подсеть другого, в
// которую он попадает. При равной маске — домен A, как было раньше.
function detectDomain(rawIp, config) {
  const ip = normalizeIp(rawIp);
  const a = bestMatch(config.network.domainACidr, ip);
  const b = bestMatch(config.network.domainBCidr, ip);
  if (a < 0 && b < 0) return null;
  return b > a ? "B" : "A";
}

module.exports = { cidrContains, normalizeIp, parseCidrList, detectDomain };
