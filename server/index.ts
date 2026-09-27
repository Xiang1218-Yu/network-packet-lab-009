import express, { type Request, type Response } from 'express';
import type {
  HexRow,
  HttpRequestInspection,
  InspectedHeader,
  InspectedQueryParam,
  InspectionDiagnostic,
  PacketScenario,
  ParseRequest,
  Protocol,
  ProtocolField,
  RequestInspection,
  SimulatedPacket,
  TimelineEvent
} from '../shared/types.js';

const app = express();
const port = Number(process.env.PORT ?? 3001);

app.use(express.json({ limit: '1mb' }));
app.use((request, response, next) => {
  response.header('Access-Control-Allow-Origin', '*');
  response.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  response.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (request.method === 'OPTIONS') return response.sendStatus(204);
  next();
});

const HTTP_SAMPLES: Record<PacketScenario, string> = {
  request: 'GET /api/devices?status=online&status=standby&q=%E4%BD%A0%E5%A5%BD&debug HTTP/1.1\r\nHost: lab.local\r\nAccept: application/json\r\nUser-Agent: PacketLab/1.0\r\nX-Trace-Id: 7f3a9c\r\n\r\n',
  response: 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 47\r\nCache-Control: no-store\r\n\r\n{"devices":[{"id":"edge-01","status":"online"}]}',
  handshake: 'GET / HTTP/1.1\r\nHost: lab.local\r\nConnection: keep-alive\r\n\r\n'
};

const TCP_SAMPLES: Record<PacketScenario, string> = {
  request: 'TCP 10.0.0.24:51842 > 10.0.0.8:443 | Seq=18492031 Ack=77120102 | Flags=ACK,PSH | Win=64240 | Len=128',
  response: 'TCP 10.0.0.8:443 > 10.0.0.24:51842 | Seq=77120102 Ack=18492159 | Flags=ACK,PSH | Win=28960 | Len=512',
  handshake: 'TCP 10.0.0.24:51842 > 10.0.0.8:443 | Seq=0 Ack=0 | Flags=SYN | Win=64240 | MSS=1460 | WS=7'
};

function hexDump(value: string): HexRow[] {
  const bytes = Array.from(Buffer.from(value, 'utf8'));
  const rows: HexRow[] = [];
  for (let index = 0; index < bytes.length; index += 16) {
    const slice = bytes.slice(index, index + 16);
    rows.push({
      offset: index.toString(16).padStart(4, '0'),
      bytes: slice.map((byte) => byte.toString(16).padStart(2, '0')),
      ascii: slice.map((byte) => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.')).join('')
    });
  }
  return rows;
}

function field(id: string, key: string, value: string, description: string, children?: ProtocolField[]): ProtocolField {
  return { id, key, value, description, ...(children ? { children } : {}) };
}

function splitHeadBody(raw: string): { head: string; body: string } {
  const match = raw.match(/\r?\n\r?\n/);
  if (!match || match.index === undefined) return { head: raw, body: '' };
  return { head: raw.slice(0, match.index), body: raw.slice(match.index + match[0].length) };
}

function parseRequestLine(startLine: string): { method: string; target: string; version: string } {
  const firstSpace = startLine.indexOf(' ');
  if (firstSpace === -1) return { method: startLine, target: '', version: '' };
  const lastSpace = startLine.lastIndexOf(' ');
  if (lastSpace === firstSpace) {
    return { method: startLine.slice(0, firstSpace), target: startLine.slice(firstSpace + 1), version: '' };
  }
  return {
    method: startLine.slice(0, firstSpace),
    target: startLine.slice(firstSpace + 1, lastSpace),
    version: startLine.slice(lastSpace + 1)
  };
}

function splitTarget(target: string): { path: string; queryString: string } {
  const question = target.indexOf('?');
  return question === -1
    ? { path: target, queryString: '' }
    : { path: target.slice(0, question), queryString: target.slice(question + 1) };
}

/**
 * Percent-decodes a single component. Byte runs are decoded as UTF-8, "+" is
 * only treated as a space inside query strings. Malformed "%" sequences stay
 * verbatim and are reported instead of throwing.
 */
function decodeComponent(raw: string, plusAsSpace: boolean): { decoded: string; malformed: string[] } {
  const malformed: string[] = [];
  const bytes: number[] = [];
  const chars: string[] = [];
  const flushBytes = () => {
    if (bytes.length) {
      chars.push(Buffer.from(bytes).toString('utf8'));
      bytes.length = 0;
    }
  };
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '%') {
      const hex = raw.slice(index + 1, index + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        index += 2;
      } else {
        flushBytes();
        malformed.push(raw.slice(index, Math.min(index + 3, raw.length)));
        chars.push(char);
      }
    } else if (char === '+' && plusAsSpace) {
      flushBytes();
      chars.push(' ');
    } else {
      flushBytes();
      chars.push(char);
    }
  }
  flushBytes();
  return { decoded: chars.join(''), malformed };
}

function parseQueryParams(queryString: string): InspectedQueryParam[] {
  // A trailing or doubled "&" produces an empty pair, which is not a real parameter.
  const pairs = queryString.split('&').filter((pair) => pair.length > 0);
  const params: InspectedQueryParam[] = pairs.map((pair, index) => {
    const separator = pair.indexOf('=');
    const rawKey = separator === -1 ? pair : pair.slice(0, separator);
    const rawValue = separator === -1 ? null : pair.slice(separator + 1);
    const keyResult = decodeComponent(rawKey, true);
    const valueResult = rawValue === null ? null : decodeComponent(rawValue, true);
    const diagnostics: InspectionDiagnostic[] = [];

    if (keyResult.malformed.length) {
      diagnostics.push({
        code: 'malformed-encoding',
        message: `键包含错误的百分号编码序列：${keyResult.malformed.join('、')}`,
        segment: rawKey
      });
    }
    if (valueResult?.malformed.length) {
      diagnostics.push({
        code: 'malformed-encoding',
        message: `值包含错误的百分号编码序列：${valueResult.malformed.join('、')}`,
        segment: rawValue ?? ''
      });
    }
    if (rawKey !== keyResult.decoded || (rawValue !== null && rawValue !== valueResult?.decoded)) {
      diagnostics.push({
        code: 'encoded-char',
        message: '包含百分号编码字符，原始文本经解码后得到当前值',
        segment: pair
      });
    }
    if (rawValue === null) {
      diagnostics.push({
        code: 'valueless-param',
        message: '参数没有 "="，不存在对应的值',
        segment: rawKey
      });
    }

    return {
      id: `insp-query-${index}`,
      fieldId: `query-${index}`,
      key: keyResult.decoded,
      rawKey,
      value: valueResult ? valueResult.decoded : null,
      rawValue,
      occurrences: 1,
      diagnostics
    };
  });

  const counts = new Map<string, number>();
  for (const param of params) counts.set(param.key, (counts.get(param.key) ?? 0) + 1);
  for (const param of params) {
    param.occurrences = counts.get(param.key) ?? 1;
    if (param.occurrences > 1) {
      param.diagnostics.push({
        code: 'duplicate-key',
        message: `键 "${param.key}" 在 query 中重复出现 ${param.occurrences} 次`,
        segment: param.rawKey
      });
    }
  }
  return params;
}

function inspectHttpRequest(raw: string): HttpRequestInspection {
  const { head, body } = splitHeadBody(raw);
  const lines = head.split(/\r?\n/);
  const startLine = lines.shift() ?? '';
  const { method, target } = parseRequestLine(startLine);
  const { path, queryString } = splitTarget(target);
  const pathResult = decodeComponent(path, false);

  const pathDiagnostics: InspectionDiagnostic[] = [];
  if (pathResult.malformed.length) {
    pathDiagnostics.push({
      code: 'malformed-encoding',
      message: `路径包含错误的百分号编码序列：${pathResult.malformed.join('、')}`,
      segment: path
    });
  }
  if (path !== pathResult.decoded) {
    pathDiagnostics.push({
      code: 'encoded-char',
      message: `路径包含编码字符，解码前为 "${path}"`,
      segment: path
    });
  }

  const query = parseQueryParams(queryString);
  const headers: InspectedHeader[] = lines.map((line, index) => {
    const separator = line.indexOf(':');
    return {
      id: `insp-header-${index}`,
      fieldId: `header-${index}`,
      key: separator > -1 ? line.slice(0, separator).trim() : `Header-${index + 1}`,
      value: separator > -1 ? line.slice(separator + 1).trim() : line.trim(),
      raw: line
    };
  });

  return {
    applicable: true,
    method: { value: method, fieldId: 'http-part-1' },
    target: { raw: target, fieldId: 'http-part-2' },
    path: { raw: path, decoded: pathResult.decoded, fieldId: 'http-part-2', diagnostics: pathDiagnostics },
    query,
    headers,
    body: { raw: body, fieldId: 'http-body' },
    diagnostics: [...pathDiagnostics, ...query.flatMap((param) => param.diagnostics)]
  };
}

function parseHttpFields(raw: string): ProtocolField[] {
  const { head, body } = splitHeadBody(raw);
  const lines = head.split(/\r?\n/);
  const startLine = lines.shift() ?? '';
  const headers = lines.map((line, index) => {
    const separator = line.indexOf(':');
    const key = separator > -1 ? line.slice(0, separator).trim() : `Header-${index + 1}`;
    const value = separator > -1 ? line.slice(separator + 1).trim() : line.trim();
    return field(`header-${index}`, key, value || '(empty)', 'HTTP header field');
  });
  const isResponse = startLine.startsWith('HTTP/');
  const [first, second, third] = startLine.split(' ');
  const branches: ProtocolField[] = [
    field('http-start-line', isResponse ? 'Status-Line' : 'Request-Line', startLine, isResponse ? 'HTTP version and response status' : 'HTTP method, target and version', [
      field('http-part-1', isResponse ? 'Version' : 'Method', first ?? '—', isResponse ? 'Protocol version' : 'HTTP request method'),
      field('http-part-2', isResponse ? 'Status' : 'Target', second ?? '—', isResponse ? 'Status code' : 'Request target'),
      field('http-part-3', isResponse ? 'Reason' : 'Version', isResponse ? (third ?? '—') : (third ?? '—'), isResponse ? 'Reason phrase' : 'Protocol version')
    ])
  ];

  if (!isResponse) {
    const { target } = parseRequestLine(startLine);
    const queryParams = parseQueryParams(splitTarget(target).queryString);
    if (queryParams.length) {
      branches.push(field('http-query', 'Query Parameters', `${queryParams.length} params`, 'Structured parameters parsed from the request target', queryParams.map((param) => {
        const notes = param.diagnostics.map((diagnostic) => diagnostic.code);
        const rawNote = param.rawKey !== param.key || (param.rawValue !== null && param.rawValue !== param.value)
          ? ` · raw: ${param.rawKey}${param.rawValue === null ? '' : `=${param.rawValue}`}`
          : '';
        return field(
          param.fieldId,
          param.key || '(empty key)',
          param.value === null ? '(no value)' : param.value,
          `${notes.length ? notes.join(', ') : 'query parameter'}${rawNote}`
        );
      })));
    }
  }

  branches.push(
    field('http-headers', 'Headers', `${headers.length} fields`, 'Metadata carried by the application layer', headers),
    field('http-body', 'Payload', body || '(empty)', 'Application payload after the header terminator')
  );
  return branches;
}

function parseTcpFields(raw: string): ProtocolField[] {
  const [route = '', ...parts] = raw.split(' | ');
  const [protocol, source = '—', arrow = '>', destination = '—'] = route.split(' ');
  const values = new Map(parts.map((part) => {
    const separator = part.indexOf('=');
    return separator > -1 ? [part.slice(0, separator), part.slice(separator + 1)] : [part, 'true'];
  }));
  return [
    field('ethernet', 'Link Layer', 'Ethernet II', 'Frame envelope', [
      field('ethernet-src', 'Source MAC', '02:42:ac:11:00:24', 'Simulated interface address'),
      field('ethernet-dst', 'Destination MAC', '02:42:ac:11:00:08', 'Simulated gateway address'),
      field('ethernet-type', 'Type', '0x0800 · IPv4', 'Network protocol identifier')
    ]),
    field('ipv4', 'Internet Layer', 'IPv4', 'Logical addressing and delivery', [
      field('ipv4-source', 'Source', source, 'Origin IP and port'),
      field('ipv4-destination', 'Destination', destination, 'Target IP and port'),
      field('ipv4-protocol', 'Next Protocol', protocol || 'TCP', 'Transport protocol')
    ]),
    field('tcp', 'Transport Layer', 'TCP', 'Reliable stream transport', [
      field('tcp-seq', 'Sequence', values.get('Seq') ?? '—', 'Byte sequence position'),
      field('tcp-ack', 'Acknowledgement', values.get('Ack') ?? '—', 'Next expected byte'),
      field('tcp-flags', 'Flags', values.get('Flags') ?? '—', 'Control bits'),
      field('tcp-window', 'Window', values.get('Win') ?? '—', 'Receive window size'),
      field('tcp-length', 'Payload Length', values.get('Len') ?? '0', 'TCP segment data length')
    ]),
    field('tcp-payload', 'Payload', values.get('Len') === '0' ? '(empty)' : 'Encrypted application data', 'Data carried by the segment')
  ];
}

function timelineFor(protocol: Protocol, scenario: PacketScenario): TimelineEvent[] {
  const prefix = protocol === 'HTTP' ? 'HTTP' : 'TCP';
  const steps = protocol === 'HTTP'
    ? [
        ['ingress', 'Frame captured', 'NIC received an application frame'],
        ['parse', 'Headers indexed', 'Start line and header fields identified'],
        ['application', `${prefix} payload decoded`, scenario === 'response' ? 'Response body is ready for inspection' : 'Request target and metadata extracted'],
        ['egress', 'Inspector ready', 'Structured representation emitted by parse API']
      ]
    : [
        ['ingress', 'Segment captured', 'Transport segment received from the simulated wire'],
        ['transport', 'TCP header decoded', 'Sequence, acknowledgement and flags extracted'],
        ['parse', 'Layer tree assembled', 'Ethernet → IPv4 → TCP hierarchy created'],
        ['egress', 'Inspector ready', 'Structured representation emitted by parse API']
      ];
  return steps.map(([phase, label, detail], index) => ({
    id: `${prefix.toLowerCase()}-${index}`,
    timestamp: `00:00:0${index}.${(index * 37 + 12).toString().padStart(2, '0')}`,
    label,
    phase: phase as TimelineEvent['phase'],
    detail
  }));
}

function checksum(raw: string): string {
  let hash = 0;
  for (const byte of Buffer.from(raw, 'utf8')) hash = (hash + byte * 31) % 65535;
  return `0x${hash.toString(16).padStart(4, '0').toUpperCase()}`;
}

function buildInspection(protocol: Protocol, raw: string): RequestInspection {
  if (protocol !== 'HTTP') {
    return { applicable: false, reason: 'TCP 段不携带 HTTP 请求语义（方法、query、header），请求语义检查器不适用。' };
  }
  const { head } = splitHeadBody(raw);
  const startLine = head.split(/\r?\n/)[0] ?? '';
  if (startLine.startsWith('HTTP/')) {
    return { applicable: false, reason: '当前报文以状态行起始，是 HTTP 响应；请求语义检查器仅解析 HTTP 请求。' };
  }
  return inspectHttpRequest(raw);
}

function buildPacket(protocol: Protocol, scenario: PacketScenario, raw: string): SimulatedPacket {
  const safeRaw = raw.trim() ? raw : (protocol === 'HTTP' ? HTTP_SAMPLES[scenario] : TCP_SAMPLES[scenario]);
  const isHttp = protocol === 'HTTP';
  return {
    id: `${protocol.toLowerCase()}-${scenario}-${Date.now().toString(36).slice(-6)}`,
    protocol,
    scenario,
    summary: isHttp
      ? `${safeRaw.split(/\r?\n/)[0]} · ${scenario === 'response' ? 'server response' : 'client request'}`
      : `${scenario === 'handshake' ? 'TCP connection handshake' : 'TCP data segment'} · ${safeRaw.split(' | ')[0]}`,
    raw: safeRaw,
    hex: hexDump(safeRaw),
    fields: isHttp ? parseHttpFields(safeRaw) : parseTcpFields(safeRaw),
    timeline: timelineFor(protocol, scenario),
    inspection: buildInspection(protocol, safeRaw),
    metadata: {
      capturedAt: new Date().toISOString().replace('T', ' ').replace('Z', ' UTC'),
      source: isHttp ? '10.0.0.24:51842' : safeRaw.split(' > ')[0].replace('TCP ', ''),
      destination: isHttp ? '10.0.0.8:443' : (safeRaw.split(' > ')[1]?.split(' | ')[0] ?? '10.0.0.8:443'),
      length: Buffer.byteLength(safeRaw, 'utf8'),
      checksum: checksum(safeRaw)
    }
  };
}

function isProtocol(value: unknown): value is Protocol { return value === 'HTTP' || value === 'TCP'; }
function isScenario(value: unknown): value is PacketScenario { return value === 'request' || value === 'response' || value === 'handshake'; }

app.get('/api/health', (_request, response) => response.json({ ok: true, service: 'network-packet-lab-api' }));

app.get('/api/simulate', (request, response) => {
  const protocol = isProtocol(request.query.protocol) ? request.query.protocol : 'HTTP';
  const scenario = isScenario(request.query.scenario) ? request.query.scenario : (protocol === 'HTTP' ? 'request' : 'handshake');
  response.json({ data: buildPacket(protocol, scenario, '') });
});

app.get('/api/packets', (request, response) => {
  const protocol = isProtocol(request.query.protocol) ? request.query.protocol : 'HTTP';
  const scenarios: PacketScenario[] = protocol === 'HTTP' ? ['request', 'response'] : ['handshake', 'request', 'response'];
  response.json({ data: scenarios.map((scenario) => buildPacket(protocol, scenario, '')) });
});

app.post('/api/parse', (request: Request<unknown, unknown, Partial<ParseRequest>>, response: Response) => {
  const protocol = isProtocol(request.body?.protocol) ? request.body.protocol : 'HTTP';
  const scenario = isScenario(request.body?.scenario) ? request.body.scenario : 'request';
  const raw = typeof request.body?.raw === 'string' ? request.body.raw : '';
  if (!raw.trim()) return response.status(400).json({ error: 'raw is required' });
  response.json({ data: buildPacket(protocol, scenario, raw) });
});

app.listen(port, () => {
  console.log(`Network Packet Lab API listening on http://localhost:${port}`);
});
