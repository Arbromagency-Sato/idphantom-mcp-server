/** Funnel de 4 eventos (AGP-100 F1.4): install → register_start →
 *  register_complete → first_pay → repeat. Cada evento se escribe como UNA
 *  línea JSON con prefijo "[funnel]" en stderr (o en un sink custom para
 *  tests). El scraping de estas líneas ES el funnel: los eventos se agregan
 *  downstream por cuenta.
 *
 *  Tagueo obligatorio: PHANTOM_FUNNEL_SOURCE=internal marca tráfico propio
 *  (dogfood/QA). El volumen internal se REPORTA SEPARADO del externo —
 *  mezclarlo para inflar métricas públicas es wash volume y riesgo de
 *  delisting (AGP-102). Default "external".
 *
 *  Dedupe first_pay/repeat: memoria por proceso (Set de hints de cuenta).
 *  Un reinicio del server reinicia el conteo — suficiente para el piloto;
 *  el agregado downstream decide first/repeat definitivo. */

export type FunnelSource = "internal" | "external";
export type FunnelEvent = "install" | "register_start" | "register_complete" | "first_pay" | "repeat";

export type FunnelSink = (line: string) => void;

export interface Funnel {
  emit: (event: FunnelEvent, data?: Record<string, unknown>) => void;
  /** Clasifica pay: first_pay la primera vez que se ve la cuenta en este
   *  proceso, repeat después. accountHint = api_key configurada o "anonymous". */
  trackPay: (accountHint: string, data?: Record<string, unknown>) => void;
}

export function createFunnel(source: FunnelSource, sink: FunnelSink = defaultSink, now: () => Date = () => new Date()): Funnel {
  const seenAccounts = new Set<string>();
  const emit = (event: FunnelEvent, data: Record<string, unknown> = {}) => {
    sink(`[funnel] ${JSON.stringify({ event, ts: now().toISOString(), source, ...data })}`);
  };
  return {
    emit,
    trackPay: (accountHint, data = {}) => {
      const key = accountHint || "anonymous";
      const event: FunnelEvent = seenAccounts.has(key) ? "repeat" : "first_pay";
      seenAccounts.add(key);
      emit(event, data);
    },
  };
}

function defaultSink(line: string): void {
  process.stderr.write(`${line}\n`);
}
