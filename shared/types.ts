export type Protocol = 'HTTP' | 'TCP';
export type PacketScenario = 'request' | 'response' | 'handshake';

export interface HexRow {
  offset: string;
  bytes: string[];
  ascii: string;
}

export interface ProtocolField {
  id: string;
  key: string;
  value: string;
  description: string;
  children?: ProtocolField[];
}

export interface TimelineEvent {
  id: string;
  timestamp: string;
  label: string;
  phase: 'ingress' | 'parse' | 'transport' | 'application' | 'egress';
  detail: string;
}

export type InspectionDiagnosticCode =
  | 'encoded-char'
  | 'malformed-encoding'
  | 'duplicate-key'
  | 'valueless-param';

export interface InspectionDiagnostic {
  code: InspectionDiagnosticCode;
  message: string;
  /** The untouched raw text segment the diagnosis is based on. */
  segment: string;
}

export interface InspectedQueryParam {
  id: string;
  /** Id of the matching node in the protocol field tree. */
  fieldId: string;
  key: string;
  rawKey: string;
  /** null when the pair has no "=" (valueless parameter). */
  value: string | null;
  rawValue: string | null;
  /** How many times the (decoded) key appears in the query string. */
  occurrences: number;
  diagnostics: InspectionDiagnostic[];
}

export interface InspectedHeader {
  id: string;
  fieldId: string;
  key: string;
  value: string;
  /** Original header line, before key/value splitting or trimming. */
  raw: string;
}

export interface HttpRequestInspection {
  applicable: true;
  method: { value: string; fieldId: string };
  /** Complete raw request target, preserved verbatim. */
  target: { raw: string; fieldId: string };
  path: {
    raw: string;
    decoded: string;
    fieldId: string;
    diagnostics: InspectionDiagnostic[];
  };
  query: InspectedQueryParam[];
  headers: InspectedHeader[];
  body: { raw: string; fieldId: string };
  /** Diagnostics collected from the path and every query parameter. */
  diagnostics: InspectionDiagnostic[];
}

export interface RequestInspectionUnavailable {
  applicable: false;
  reason: string;
}

export type RequestInspection = HttpRequestInspection | RequestInspectionUnavailable;

export interface SimulatedPacket {
  id: string;
  protocol: Protocol;
  scenario: PacketScenario;
  summary: string;
  raw: string;
  hex: HexRow[];
  fields: ProtocolField[];
  timeline: TimelineEvent[];
  /** Semantic request inspection; not applicable to TCP segments / HTTP responses. */
  inspection: RequestInspection;
  metadata: {
    capturedAt: string;
    source: string;
    destination: string;
    length: number;
    checksum: string;
  };
}

export interface ParseRequest {
  protocol: Protocol;
  scenario: PacketScenario;
  raw: string;
}
