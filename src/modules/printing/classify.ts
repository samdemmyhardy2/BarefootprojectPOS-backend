export type DeviceType = 'printer' | 'router' | 'computer' | 'mobile' | 'server' | 'unknown';
export type Confidence = 'high' | 'medium' | 'low';

export type DiscoveryInput = {
  ip: string;
  macAddress?: string;
  hostname?: string;
  vendor?: string;
  openPorts?: number[];
  snmpText?: string;
};

export type ClassifiedDevice = {
  ip: string;
  macAddress: string;
  hostname: string;
  vendor: string;
  manufacturer: string;
  model: string;
  deviceType: DeviceType;
  confidence: Confidence;
  protocols: string[];
  openPorts: number[];
  evidence: string[];
};

const PRINTER_BRANDS = ['epson', 'hp', 'hewlett-packard', 'brother', 'canon', 'star', 'citizen', 'bixolon', 'xprinter'];
const ROUTER_VENDORS = ['cisco', 'ubiquiti', 'mikrotik', 'tp-link', 'tplink', 'netgear', 'asus', 'linksys'];
const MOBILE_VENDORS = ['apple', 'samsung', 'xiaomi', 'google', 'oneplus', 'huawei', 'oppo', 'vivo'];

const OUI: Record<string, string> = {
  '000048': 'Epson',
  '00000C': 'Cisco',
  '000393': 'Apple',
  '00166C': 'Samsung',
};

export function vendorFromMac(mac?: string) {
  const normalized = mac?.toLowerCase().replace(/[^a-f0-9]/g, '').slice(0, 6) ?? '';
  return OUI[normalized] ?? '';
}

export function classifyDevice(input: DiscoveryInput): ClassifiedDevice {
  const openPorts = [...new Set(input.openPorts ?? [])].sort((a, b) => a - b);
  const macAddress = (input.macAddress ?? '').toUpperCase();
  const hostname = input.hostname?.trim() ?? '';
  const vendor = input.vendor?.trim() || vendorFromMac(macAddress);
  const text = [hostname, vendor, input.snmpText ?? ''].join(' ');
  const identity = printerIdentity(text);
  const protocols = protocolsFor(openPorts, Boolean(input.snmpText));
  const evidence: string[] = [];
  if (identity.manufacturer || identity.model) evidence.push('SNMP or advertised name identified a printer');
  if (openPorts.includes(9100)) evidence.push('TCP 9100 available');
  if (openPorts.includes(631)) evidence.push('IPP port 631 available');
  if (openPorts.includes(515)) evidence.push('LPR port 515 available');
  if (input.snmpText) evidence.push('SNMP description received');
  if (vendor) evidence.push(`Hardware vendor ${vendor}`);

  const printerSignal = Boolean(identity.manufacturer || identity.model) || openPorts.some((port) => [9100, 631, 515].includes(port));
  let deviceType: DeviceType = 'unknown';
  let confidence: Confidence = 'low';
  if (printerSignal) {
    deviceType = 'printer';
    const signals = [Boolean(identity.model), openPorts.includes(9100), openPorts.includes(631), Boolean(input.snmpText)].filter(Boolean).length;
    confidence = signals >= 2 || (identity.model && openPorts.includes(9100)) ? 'high' : 'medium';
    if (!identity.model) evidence.push('Printer candidate; model was not identified');
  } else if (ROUTER_VENDORS.some((name) => vendor.toLowerCase().includes(name)) || input.ip.endsWith('.1')) {
    deviceType = 'router';
    confidence = vendor ? 'medium' : 'low';
    evidence.push(input.ip.endsWith('.1') ? 'Address is the usual gateway host' : 'Vendor matches a network device');
  } else if (MOBILE_VENDORS.some((name) => vendor.toLowerCase().includes(name))) {
    deviceType = 'mobile';
    confidence = 'medium';
  } else if (openPorts.includes(22) || openPorts.includes(3389) || openPorts.includes(445)) {
    deviceType = 'computer';
    confidence = 'low';
    evidence.push('Host responds like a computer');
  } else if (openPorts.includes(80) || openPorts.includes(443)) {
    deviceType = 'server';
    confidence = 'low';
  }

  return {
    ip: input.ip,
    macAddress,
    hostname,
    vendor,
    manufacturer: identity.manufacturer,
    model: identity.model,
    deviceType,
    confidence,
    protocols,
    openPorts,
    evidence,
  };
}

export function printerIdentity(text: string) {
  const normalized = text.toLowerCase();
  const manufacturer = PRINTER_BRANDS.find((brand) => normalized.includes(brand)) ?? '';
  const branded = manufacturer === 'hp' ? 'HP' : manufacturer === 'hewlett-packard' ? 'HP' : manufacturer ? manufacturer[0].toUpperCase() + manufacturer.slice(1) : '';
  const modelMatch = text.match(/TM-[A-Za-z0-9]+/i);
  const model = modelMatch?.[0] ?? '';
  return { manufacturer: model && !branded ? 'Epson' : branded, model };
}

function protocolsFor(openPorts: number[], snmp: boolean) {
  const protocols: string[] = [];
  if (openPorts.includes(9100)) protocols.push('RAW');
  if (openPorts.includes(631)) protocols.push('IPP');
  if (openPorts.includes(515)) protocols.push('LPR');
  if (snmp) protocols.push('SNMP');
  return protocols;
}
