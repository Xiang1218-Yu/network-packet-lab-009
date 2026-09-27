import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type {
  InspectionDiagnostic,
  InspectionDiagnosticCode,
  PacketScenario,
  ParseRequest,
  Protocol,
  ProtocolField,
  RequestInspection,
  SimulatedPacket,
  TimelineEvent
} from '../../shared/types';

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001';

const scenarioLabels: Record<PacketScenario, string> = {
  request: '请求 / Request',
  response: '响应 / Response',
  handshake: '握手 / Handshake'
};

function App() {
  const [protocol, setProtocol] = useState<Protocol>('HTTP');
  const [scenario, setScenario] = useState<PacketScenario>('request');
  const [rawInput, setRawInput] = useState('');
  const [packet, setPacket] = useState<SimulatedPacket | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeView, setActiveView] = useState<'overview' | 'hex' | 'inspector'>('overview');
  const [highlightFieldId, setHighlightFieldId] = useState<string | null>(null);

  const availableScenarios = useMemo<PacketScenario[]>(
    () => (protocol === 'TCP' ? ['handshake', 'request', 'response'] : ['request', 'response']),
    [protocol]
  );

  const request = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${API_BASE}${path}`, init);
    if (!response.ok) throw new Error(`API 请求失败：${response.status}`);
    return response.json() as Promise<{ data: SimulatedPacket }>;
  };

  const loadSample = async (nextProtocol = protocol, nextScenario = scenario) => {
    setLoading(true);
    setError('');
    try {
      const result = await request(
        `/api/simulate?protocol=${nextProtocol}&scenario=${nextScenario}`
      );
      setPacket(result.data);
      setRawInput(result.data.raw);
      setHighlightFieldId(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载模拟数据失败');
    } finally {
      setLoading(false);
    }
  };

  const parsePacket = async () => {
    setLoading(true);
    setError('');
    const body: ParseRequest = { protocol, scenario, raw: rawInput };
    try {
      const result = await request('/api/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      setPacket(result.data);
      setRawInput(result.data.raw);
      setHighlightFieldId(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '解析数据包失败');
    } finally {
      setLoading(false);
    }
  };

  const jumpToField = (fieldId: string) => {
    setActiveView('overview');
    setHighlightFieldId(fieldId);
  };

  useEffect(() => {
    void loadSample('HTTP', 'request');
  }, []);

  const changeProtocol = (nextProtocol: Protocol) => {
    const nextScenario = nextProtocol === 'TCP' && scenario === 'response' ? 'handshake' : scenario;
    setProtocol(nextProtocol);
    setScenario(nextScenario);
    void loadSample(nextProtocol, nextScenario);
  };

  const changeScenario = (nextScenario: PacketScenario) => {
    setScenario(nextScenario);
    void loadSample(protocol, nextScenario);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><span /> <span /> <span /></div>
          <div>
            <p className="eyebrow">PROJECT 10 / PACKET OBSERVATORY</p>
            <h1>网络协议数据包可视化实验室</h1>
          </div>
        </div>
        <div className="connection-status"><i /> API ONLINE <span>localhost:3001</span></div>
      </header>

      <main className="dashboard">
        <section className="hero-copy">
          <div>
            <p className="section-kicker">解析工作台 · INSPECTOR</p>
            <h2>把每一个字节，<em>还原成可读的网络故事。</em></h2>
            <p className="hero-subtitle">选择协议和场景，载入模拟流量，逐层查看字段、时间线与十六进制原始数据。</p>
          </div>
          <div className="hero-stat"><strong>{packet?.metadata.length ?? '—'}</strong><span>BYTES<br />CURRENT FRAME</span></div>
        </section>

        <section className="control-panel panel">
          <div className="control-group">
            <label>协议 <span>PROTOCOL</span></label>
            <div className="segmented-control">
              {(['HTTP', 'TCP'] as Protocol[]).map((item) => (
                <button key={item} className={protocol === item ? 'active' : ''} onClick={() => changeProtocol(item)}>{item}</button>
              ))}
            </div>
          </div>
          <div className="control-group scenario-control">
            <label>模拟场景 <span>SCENARIO</span></label>
            <select value={scenario} onChange={(event) => changeScenario(event.target.value as PacketScenario)}>
              {availableScenarios.map((item) => <option key={item} value={item}>{scenarioLabels[item]}</option>)}
            </select>
          </div>
          <div className="control-actions">
            <button className="button ghost" onClick={() => void loadSample()} disabled={loading}>↻ 载入模拟包</button>
            <button className="button primary" onClick={() => void parsePacket()} disabled={loading || !rawInput.trim()}>{loading ? '处理中…' : '解析数据包 →'}</button>
          </div>
        </section>

        {error && <div className="error-banner">⚠ {error} <button onClick={() => setError('')}>关闭</button></div>}

        <section className="workspace-grid">
          <div className="left-column">
            <div className="panel packet-input-panel">
              <div className="panel-heading"><div><p className="section-kicker">01 / INPUT STREAM</p><h3>数据包输入</h3></div><span className="badge">{protocol}</span></div>
              <textarea value={rawInput} onChange={(event) => setRawInput(event.target.value)} spellCheck={false} aria-label="原始数据包输入" />
              <div className="input-footer"><span>{rawInput.length} chars · editable payload</span><button onClick={() => setRawInput('')}>清空输入</button></div>
            </div>
            <div className="panel timeline-panel">
              <div className="panel-heading"><div><p className="section-kicker">02 / EVENT TRACE</p><h3>传输时间线</h3></div><span className="trace-id">{packet?.id ?? 'WAITING'}</span></div>
              <Timeline events={packet?.timeline ?? []} />
            </div>
          </div>

          <div className="right-column">
            <div className="panel packet-summary">
              <div className="summary-top"><div><p className="section-kicker">ACTIVE FRAME</p><h3>{packet?.summary ?? '等待数据包'}</h3></div><div className="live-chip"><i /> DECODED</div></div>
              <div className="metadata-grid">
                <Meta label="SOURCE" value={packet?.metadata.source ?? '—'} />
                <Meta label="DESTINATION" value={packet?.metadata.destination ?? '—'} />
                <Meta label="CAPTURED AT" value={packet?.metadata.capturedAt ?? '—'} />
                <Meta label="CHECKSUM" value={packet?.metadata.checksum ?? '—'} />
              </div>
            </div>

            <div className="panel details-panel">
              <div className="tabs">
                <button className={activeView === 'overview' ? 'selected' : ''} onClick={() => setActiveView('overview')}>协议字段树</button>
                <button className={activeView === 'hex' ? 'selected' : ''} onClick={() => setActiveView('hex')}>十六进制视图</button>
                <button className={activeView === 'inspector' ? 'selected' : ''} onClick={() => setActiveView('inspector')}>请求检查器</button>
              </div>
              {activeView === 'overview'
                ? <FieldTree fields={packet?.fields ?? []} highlightId={highlightFieldId} />
                : activeView === 'hex'
                  ? <HexView rows={packet?.hex ?? []} />
                  : <RequestInspector inspection={packet?.inspection} onJump={jumpToField} />}
            </div>
          </div>
        </section>
      </main>
      <footer className="footer"><span>PACKET LAB / EDUCATIONAL SIMULATOR</span><span>React + Vite + TypeScript · Express API</span></footer>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return <div className="meta-item"><span>{label}</span><strong>{value}</strong></div>;
}

function FieldTree({ fields, highlightId }: { fields: ProtocolField[]; highlightId: string | null }) {
  const ancestorIds = useMemo(() => {
    const set = new Set<string>();
    if (!highlightId) return set;
    const walk = (nodes: ProtocolField[], trail: string[]) => {
      for (const node of nodes) {
        if (node.id === highlightId) trail.forEach((id) => set.add(id));
        else if (node.children?.length) walk(node.children, [...trail, node.id]);
      }
    };
    walk(fields, []);
    return set;
  }, [fields, highlightId]);

  if (!fields.length) return <div className="empty-state">解析后将在这里显示协议层级字段。</div>;
  return (
    <div className="field-tree">
      {fields.map((fieldNode) => (
        <FieldNode key={fieldNode.id} field={fieldNode} depth={0} highlightId={highlightId} ancestorIds={ancestorIds} />
      ))}
    </div>
  );
}

function FieldNode({ field, depth, highlightId, ancestorIds }: { field: ProtocolField; depth: number; highlightId: string | null; ancestorIds: Set<string> }) {
  const [expanded, setExpanded] = useState(true);
  const rowRef = useRef<HTMLDivElement>(null);
  const hasChildren = Boolean(field.children?.length);
  const isHighlighted = field.id === highlightId;

  useEffect(() => {
    if (ancestorIds.has(field.id)) setExpanded(true);
  }, [ancestorIds, field.id]);

  useEffect(() => {
    if (!isHighlighted) return;
    const timer = window.setTimeout(() => rowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
    return () => window.clearTimeout(timer);
  }, [isHighlighted, highlightId]);

  return <div className="field-node" style={{ '--depth': depth } as CSSProperties}>
    <div ref={rowRef} className={`field-row${isHighlighted ? ' highlighted' : ''}`} onClick={() => hasChildren && setExpanded((value) => !value)}>
      <span className={`chevron ${hasChildren ? '' : 'invisible'} ${expanded ? 'open' : ''}`}>⌄</span>
      <span className="field-key">{field.key}</span>
      <span className="field-value">{field.value}</span>
      <span className="field-description">{field.description}</span>
    </div>
    {hasChildren && expanded && <div className="field-children">{field.children!.map((child) => <FieldNode key={child.id} field={child} depth={depth + 1} highlightId={highlightId} ancestorIds={ancestorIds} />)}</div>}
  </div>;
}

const diagnosticLabels: Record<InspectionDiagnosticCode, string> = {
  'encoded-char': '编码字符',
  'malformed-encoding': '编码错误',
  'duplicate-key': '重复 key',
  'valueless-param': '无值参数'
};

function DiagnosticBadges({ diagnostics }: { diagnostics: InspectionDiagnostic[] }) {
  if (!diagnostics.length) return null;
  return (
    <span className="diag-badges">
      {diagnostics.map((diagnostic, index) => (
        <span key={index} className={`diag-badge diag-${diagnostic.code}`} title={diagnostic.message}>
          {diagnosticLabels[diagnostic.code]}
        </span>
      ))}
    </span>
  );
}

function InspectorRow({ fieldId, fieldKey, children, onJump }: { fieldId: string; fieldKey: string; children: ReactNode; onJump: (fieldId: string) => void }) {
  return (
    <button type="button" className="insp-row" onClick={() => onJump(fieldId)} title="在协议字段树中定位此项">
      <span className="insp-key">{fieldKey}</span>
      <span className="insp-value">{children}</span>
      <span className="insp-jump" aria-hidden>↪ 字段树</span>
    </button>
  );
}

function InspectorSection({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="insp-section">
      <div className="insp-section-title">
        <span>{title}</span>
        {count !== undefined && <span>{count} 项</span>}
      </div>
      {children}
    </section>
  );
}

function RawHint({ label, value }: { label: string; value: string }) {
  return <span className="insp-raw">{label}: {value}</span>;
}

function RequestInspector({ inspection, onJump }: { inspection: RequestInspection | undefined; onJump: (fieldId: string) => void }) {
  if (!inspection) {
    return (
      <div className="empty-state na-state">
        <span className="na-chip">N / A</span>
        <p>等待数据包载入。</p>
      </div>
    );
  }

  if (!inspection.applicable) {
    return (
      <div className="empty-state na-state">
        <span className="na-chip">N / A · 不适用</span>
        <p>请求语义检查器对当前数据包不适用。</p>
        <p className="na-reason">{inspection.reason}</p>
      </div>
    );
  }

  return (
    <div className="inspector">
      {inspection.diagnostics.length > 0 && (
        <section className="diag-summary">
          <div className="diag-summary-title">⚠ {inspection.diagnostics.length} 项局部诊断 · 原始文本已保留</div>
          {inspection.diagnostics.map((diagnostic, index) => (
            <div className="diag-item" key={index}>
              <span className={`diag-badge diag-${diagnostic.code}`}>{diagnosticLabels[diagnostic.code]}</span>
              <span className="diag-message">{diagnostic.message}</span>
              <code className="diag-segment">{diagnostic.segment}</code>
            </div>
          ))}
        </section>
      )}

      <InspectorSection title="请求行 / REQUEST LINE">
        <InspectorRow fieldId={inspection.method.fieldId} fieldKey="Method" onJump={onJump}>
          {inspection.method.value || '(empty)'}
        </InspectorRow>
        <InspectorRow fieldId={inspection.target.fieldId} fieldKey="Target 原始" onJump={onJump}>
          {inspection.target.raw || '(empty)'}
        </InspectorRow>
        <InspectorRow fieldId={inspection.path.fieldId} fieldKey="Path 解码" onJump={onJump}>
          {inspection.path.decoded || '(empty)'}
          {inspection.path.raw !== inspection.path.decoded && <RawHint label="原始" value={inspection.path.raw} />}
          <DiagnosticBadges diagnostics={inspection.path.diagnostics} />
        </InspectorRow>
      </InspectorSection>

      <InspectorSection title="Query 参数 / QUERY PARAMETERS" count={inspection.query.length}>
        {inspection.query.length === 0
          ? <div className="insp-empty">请求目标不包含 query 参数。</div>
          : inspection.query.map((param) => (
            <InspectorRow key={param.id} fieldId={param.fieldId} fieldKey={param.key || '(空 key)'} onJump={onJump}>
              {param.value === null ? <em className="insp-novalue">(无值)</em> : param.value}
              {(param.rawKey !== param.key || (param.rawValue !== null && param.rawValue !== param.value)) && (
                <RawHint label="原始" value={`${param.rawKey}${param.rawValue === null ? '' : `=${param.rawValue}`}`} />
              )}
              <DiagnosticBadges diagnostics={param.diagnostics} />
            </InspectorRow>
          ))}
      </InspectorSection>

      <InspectorSection title="请求头 / HEADERS" count={inspection.headers.length}>
        {inspection.headers.length === 0
          ? <div className="insp-empty">请求不包含任何 header。</div>
          : inspection.headers.map((header) => (
            <InspectorRow key={header.id} fieldId={header.fieldId} fieldKey={header.key} onJump={onJump}>
              {header.value || '(empty)'}
            </InspectorRow>
          ))}
      </InspectorSection>

      <InspectorSection title="请求体 / BODY">
        <button type="button" className="insp-row insp-row-body" onClick={() => onJump(inspection.body.fieldId)} title="在协议字段树中定位此项">
          <span className="insp-key">Payload</span>
          <span className="insp-value">
            {inspection.body.raw
              ? <code className="insp-body">{inspection.body.raw}</code>
              : <em className="insp-novalue">(empty)</em>}
          </span>
          <span className="insp-jump" aria-hidden>↪ 字段树</span>
        </button>
      </InspectorSection>
    </div>
  );
}

function Timeline({ events }: { events: TimelineEvent[] }) {
  if (!events.length) return <div className="empty-state">还没有事件记录。</div>;
  return <div className="timeline">{events.map((event, index) => <div className="timeline-event" key={event.id}><div className="timeline-marker"><span>{String(index + 1).padStart(2, '0')}</span></div><div className="timeline-content"><div><strong>{event.label}</strong><time>{event.timestamp}</time></div><p>{event.detail}</p><span className={`phase phase-${event.phase}`}>{event.phase}</span></div></div>)}</div>;
}

function HexView({ rows }: { rows: SimulatedPacket['hex'] }) {
  if (!rows.length) return <div className="empty-state">没有可显示的十六进制内容。</div>;
  return <div className="hex-view"><div className="hex-header"><span>OFFSET</span><span>HEX BYTES</span><span>ASCII</span></div>{rows.map((row) => <div className="hex-row" key={row.offset}><code>{row.offset}</code><code>{row.bytes.join(' ')}</code><code className="ascii">{row.ascii}</code></div>)}</div>;
}

export default App;
