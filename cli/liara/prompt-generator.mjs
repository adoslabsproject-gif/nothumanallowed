#!/usr/bin/env node
/**
 * Liara — Prompt Generator
 * Generates 2000 diversified prompts for multi-agent deliberation training.
 *
 * Output: ~/.legion/liara/prompts.json
 *
 * Usage: node ~/.legion/liara/prompt-generator.mjs
 */

import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(__dirname, 'prompts.json');

// ============================================================================
// Conflict Types
// ============================================================================

const CONFLICT_TYPES = [
  'values_tradeoff',
  'technical_disagreement',
  'prediction_uncertainty',
  'ethical_dilemma',
  'resource_allocation',
  'risk_assessment',
  'strategy_choice',
  'diagnosis_ambiguity',
];

// ============================================================================
// Domains (50+)
// ============================================================================

const DOMAINS = [
  // Tech & Software
  'cybersecurity', 'software_architecture', 'devops', 'ai_ml',
  'data_engineering', 'cloud_infrastructure', 'frontend_engineering',
  'database_systems', 'distributed_systems', 'networking',
  // Industrial & Engineering
  'oleodinamica', 'pneumatica', 'meccanica_industriale', 'automazione_industriale',
  'elettronica', 'ingegneria_civile', 'ingegneria_energetica',
  // Legal & Compliance
  'compliance_gdpr', 'regolamentazione_ai', 'diritto_lavoro',
  'proprieta_intellettuale', 'contrattualistica', 'diritto_penale_informatico',
  // Business & Economics
  'economia', 'finanza', 'strategia_aziendale', 'marketing',
  'supply_chain', 'hr_management', 'startup_strategy',
  // Medicine & Health
  'medicina', 'farmacologia', 'sanita_pubblica', 'neuroscienze',
  'bioetica', 'genetica',
  // Energy & Environment
  'energia', 'ambiente', 'sostenibilita', 'climate_policy',
  // Humanities
  'filosofia', 'etica', 'epistemologia', 'psicologia',
  'sociologia', 'decision_making', 'pedagogia',
  // Geopolitics & Policy
  'geopolitica', 'diplomazia', 'politica_internazionale', 'governance',
  // Infrastructure
  'urbanistica', 'trasporti', 'infrastruttura_critica', 'logistica',
  // Agriculture & Biotech
  'agricoltura', 'alimentazione', 'biotecnologie',
  // Communication
  'comunicazione', 'brand_strategy', 'crisis_management',
];

// ============================================================================
// Prompt Bank — organized by domain × conflict_type
// Each entry is a function that returns a unique prompt string.
// We use parameter variation to ensure diversity within each template.
// ============================================================================

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function pickN(arr, n) {
  const s = [...arr].sort(() => Math.random() - 0.5);
  return s.slice(0, n);
}
function num(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

const PROMPT_BANK = {
  // ========== CYBERSECURITY ==========
  cybersecurity: {
    values_tradeoff: [
      () => `Un'azienda fintech con ${num(50,500)} dipendenti scopre che il suo WAF open-source blocca il ${num(2,8)}% delle richieste legittime ma ferma il ${num(95,99)}% degli attacchi. Passare a un WAF commerciale ridurrebbe i falsi positivi al ${num(0.1,1)}% ma costa ${num(200,800)}K€/anno e richiede di inviare tutto il traffico a un vendor americano. Il CISO vuole il commerciale, il CTO vuole restare open-source e migliorarlo, il DPO si preoccupa del GDPR. Come si risolve?`,
      () => `Un governo europeo deve decidere se rendere obbligatoria la backdoor nelle comunicazioni cifrate per combattere il terrorismo. Le forze dell'ordine sostengono che ${num(30,60)} indagini l'anno falliscono per la cifratura end-to-end. Le aziende tech avvertono che una backdoor comprometterebbe ${num(100,500)} milioni di utenti. Le ONG per i diritti civili presentano ${num(5,15)} casi storici di abuso di backdoor da parte di regimi autoritari. Qual è la politica corretta?`,
      () => `Una piattaforma social con ${num(10,100)}M utenti deve decidere se implementare la scansione client-side delle immagini per materiale CSAM. La tecnologia ha un tasso di falsi positivi dello ${num(0.01,0.1)}%, che su ${num(10,100)}M utenti significa ${num(1000,100000)} persone falsamente segnalate. Non implementarla significa che ${num(100,1000)} casi reali non vengono rilevati. Privacy vs protezione dei minori. Cosa raccomandi?`,
      () => `Un red team scopre una vulnerabilità zero-day in un software usato dal ${num(60,90)}% delle infrastrutture critiche nazionali. Il vendor stima ${num(3,12)} mesi per la patch. L'agenzia di intelligence nazionale chiede di non divulgarla per ${num(6,18)} mesi per usarla in operazioni offensive. Se trapela, il danno potenziale è stimato in ${num(1,50)} miliardi di euro. Responsible disclosure immediata o cooperazione con l'intelligence?`,
    ],
    technical_disagreement: [
      () => `Un team di sicurezza dibatte l'architettura di un SIEM per un'infrastruttura con ${num(5000,50000)} endpoint. L'opzione A è ELK stack self-hosted: costo ${num(50,150)}K€/anno, latenza media ${num(2,10)}s, retention ${num(30,90)} giorni, ma richiede ${num(3,8)} FTE per la manutenzione. L'opzione B è un SIEM SaaS: costo ${num(200,600)}K€/anno, latenza ${num(0.5,2)}s, retention ${num(365,730)} giorni, ma i log escono dal perimetro aziendale. Quale scegli e perché?`,
      () => `Per la protezione anti-DDoS di un'infrastruttura che serve ${num(1,10)}M richieste/secondo: approccio A con scrubbing center on-premise (investimento ${num(500,2000)}K€, latenza aggiuntiva ${num(0.5,2)}ms) oppure approccio B con CDN/proxy cloud come Cloudflare (${num(50,200)}K€/anno, ma il vendor vede tutto il traffico in chiaro e potrebbe essere compromesso). L'infrastruttura gestisce dati ${pick(['sanitari', 'finanziari', 'governativi', 'militari'])}. Quale architettura è corretta?`,
      () => `Zero Trust vs VPN tradizionale per ${num(200,5000)} dipendenti in remote working. Il modello Zero Trust richiede ${num(12,24)} mesi di implementazione e ${num(300,800)}K€, ma elimina il ${num(85,95)}% delle superfici di attacco laterale. La VPN esistente funziona, costa ${num(30,80)}K€/anno, ma ${num(3,8)} breach negli ultimi ${num(2,5)} anni sono avvenute tramite pivot post-VPN. Il budget è di ${num(200,500)}K€. Come procedi?`,
    ],
    risk_assessment: [
      () => `Un'azienda che gestisce ${num(10,100)}M record di dati personali scopre un'intrusione avvenuta ${num(15,60)} giorni fa. L'attaccante ha avuto accesso in lettura ai database per ${num(3,30)} giorni. Non ci sono prove di esfiltrazione ma nemmeno log sufficienti per escluderla. Il GDPR richiede notifica entro 72 ore dalla scoperta. Il team legale vuole minimizzare, il CISO vuole full disclosure, il CEO teme il crollo del titolo in borsa (${num(5,30)}% stimato). Come si procede?`,
      () => `Un penetration test rivela che ${num(30,70)}% dei dipendenti di una banca cliccano link di phishing. Il costo di un training di awareness è ${num(50,200)}K€. Il costo medio di un attacco phishing riuscito nel settore è ${num(500,5000)}K€ con probabilità annua del ${num(20,60)}%. Il CFO sostiene che il training non è misurabile, il CISO chiede anche una soluzione tecnica (email gateway avanzato, altri ${num(100,300)}K€). Budget disponibile: ${num(150,400)}K€. Come allochi le risorse?`,
    ],
    prediction_uncertainty: [
      () => `Con l'arrivo dei computer quantistici, quando diventerà vulnerabile la crittografia RSA-2048? Le stime vanno da ${num(5,10)} anni (ottimisti quantistici) a ${num(20,30)} anni (scettici). La migrazione a crittografia post-quantistica per un'organizzazione con ${num(100,10000)} sistemi richiede ${num(2,5)} anni e ${num(1,20)}M€. Migrare ora significa spendere soldi per una minaccia incerta. Aspettare potrebbe significare essere vulnerabili. Qual è la strategia corretta?`,
    ],
    ethical_dilemma: [
      () => `Un ricercatore di sicurezza scopre che un'app usata da ${num(10,50)}M di persone in ${pick(['Myanmar', 'Iran', 'Cina', 'Russia', 'Arabia Saudita'])} per aggirare la censura governativa ha una vulnerabilità critica. Segnalarla al vendor (che potrebbe essere infiltrato dal governo) potrebbe portare alla chiusura dell'app e mettere a rischio gli utenti. Non segnalarla lascia ${num(10,50)}M di persone vulnerabili a exploit. Pubblicare un advisory pubblico avviserebbe sia gli utenti sia il governo. Cosa deve fare il ricercatore?`,
    ],
    resource_allocation: [
      () => `Il CISO ha budget di ${num(500,2000)}K€ per il prossimo anno. Le priorità in competizione: (A) SOC 24/7 con ${num(4,8)} analisti — ${num(400,800)}K€, (B) bug bounty program — ${num(100,300)}K€, (C) aggiornamento firewall/IDS — ${num(200,400)}K€, (D) formazione sicurezza per ${num(500,3000)} dipendenti — ${num(50,150)}K€, (E) audit di compliance — ${num(100,250)}K€. L'anno scorso ci sono stati ${num(2,8)} incidenti. Non puoi fare tutto. Come allochi?`,
    ],
    strategy_choice: [
      () => `Un'azienda di ${num(50,500)} persone deve scegliere tra: (A) costruire un team di sicurezza interno (${num(3,8)} persone, costo ${num(300,800)}K€/anno, tempo di setup ${num(6,18)} mesi), oppure (B) MSSP esterno (${num(100,300)}K€/anno, operativo in ${num(1,3)} mesi, ma con SLA di risposta di ${num(15,60)} minuti e accesso remoto alla rete). L'azienda opera in un settore ${pick(['regolamentato', 'ad alta innovazione', 'con proprietà intellettuale critica', 'esposto a nation-state actors'])}. Quale strategia è migliore a ${num(1,5)} anni?`,
    ],
    diagnosis_ambiguity: [
      () => `Un server di produzione mostra ${num(3,10)} sintomi anomali: CPU spike periodici ogni ${num(5,30)} minuti, ${num(100,1000)}MB di traffico outbound verso ${num(3,10)} IP diversi in ${pick(['Europa dell\'Est', 'Asia', 'Sud America', 'Tor exit nodes'])}, un processo con nome simile a un servizio legittimo ma con PID anomalo, e ${num(2,5)} file modificati in /tmp. Potrebbe essere: (A) cryptominer, (B) APT con C2 beaconing, (C) legittimo processo di monitoring mal configurato, (D) worm in propagazione laterale. Hai ${num(1,4)} ore prima che il management chieda un verdetto. Come investigi e cosa concludi?`,
    ],
  },

  // ========== SOFTWARE ARCHITECTURE ==========
  software_architecture: {
    technical_disagreement: [
      () => `Un SaaS B2B con ${num(1,50)}K clienti enterprise deve rearchitettare il backend. Il tech lead propone microservizi (${num(15,40)} servizi, Kubernetes, ${num(6,18)} mesi di migrazione). L'architect propone modular monolith (${num(3,6)} mesi, costo ${num(50,70)}% inferiore). Il team è di ${num(5,20)} sviluppatori. I microservizi promettono scalabilità indipendente ma aggiungono complessità operativa (service mesh, distributed tracing, eventual consistency). Il monolith modulare è più semplice ma potrebbe non scalare oltre ${num(10,100)}K req/sec. Quale approccio e perché?`,
      () => `Event sourcing + CQRS vs CRUD tradizionale per un sistema di ${pick(['trading finanziario', 'gestione ordini e-commerce', 'prenotazioni sanitarie', 'gestione flotta logistica'])} con ${num(1,100)}M transazioni/giorno. L'event sourcing offre audit trail completo e temporal queries ma aggiunge complessità (event store, proiezioni, gestione dello schema evolution). Il CRUD è semplice ma perde la storia delle modifiche. Il team ha ${num(0,2)} persone con esperienza in event sourcing su ${num(5,20)} totali. Cosa scegli?`,
      () => `GraphQL vs REST per un'API pubblica che serve ${num(50,500)} client diversi (mobile, web, IoT, partner). GraphQL riduce overfetching del ${num(30,60)}% e permette ai client di chiedere esattamente ciò che serve. REST è più semplice da cacheare, monitorare, e rate-limitare. Il team sicurezza nota che GraphQL è vulnerabile a query di profondità arbitraria e introspection abuse. Il team frontend lo vuole disperatamente. Come decidi?`,
    ],
    values_tradeoff: [
      () => `Un sistema legacy in ${pick(['COBOL', 'Delphi', 'Visual Basic 6', 'Perl', 'ColdFusion'])} funziona perfettamente da ${num(10,25)} anni, gestisce ${num(100,500)}M€ di transazioni/anno, ma: (A) solo ${num(1,3)} persone nel team lo conoscono e andranno in pensione tra ${num(2,5)} anni, (B) non si integra con le nuove API, (C) costa ${num(500,2000)}K€/anno di manutenzione. La riscrittura completa in stack moderno richiede ${num(18,48)} mesi e ${num(1,5)}M€. Lo strangler fig pattern richiederebbe ${num(3,7)} anni. Il CEO vuole risultati in ${num(12,18)} mesi. Come procedi?`,
    ],
    strategy_choice: [
      () => `Build vs buy per un ${pick(['motore di raccomandazione', 'sistema di pagamenti', 'piattaforma di analytics', 'engine di ricerca full-text', 'sistema di autenticazione', 'pipeline di data processing'])}. Build: ${num(6,18)} mesi, ${num(3,8)} sviluppatori dedicati, pieno controllo, ma costo totale ${num(300,1500)}K€ il primo anno. Buy: operativo in ${num(1,3)} mesi, ${num(50,300)}K€/anno, ma vendor lock-in, limiti di customizzazione, e il vendor potrebbe essere acquisito o fallire. L'azienda ha ${num(10,100)} sviluppatori totali. Cosa scegli?`,
    ],
    risk_assessment: [
      () => `Un sistema con ${num(99.9,99.99)}% di uptime storico deve decidere il target SLA per il prossimo contratto enterprise da ${num(1,10)}M€/anno. Il cliente vuole ${pick(['99.99%', '99.999%'])} con penali del ${num(5,25)}% per ogni ${num(0.01,0.1)}% sotto target. Passare da 99.9% a 99.99% richiede: active-active multi-region (${num(200,500)}K€/anno extra), chaos engineering team (${num(2,4)} persone), runbook automatizzati. Il margine sul contratto è ${num(20,40)}%. Accetti lo SLA o negozi?`,
    ],
    resource_allocation: [
      () => `Un team di ${num(8,25)} sviluppatori deve allocare il prossimo trimestre tra: (A) ridurre il debito tecnico accumulato in ${num(2,5)} anni (${num(200,500)} issue aperte, ${num(30,60)}% di test coverage), (B) sviluppare ${num(3,8)} feature richieste dai clienti enterprise (revenue potenziale ${num(200,800)}K€/trimestre), (C) migrare da ${pick(['AWS a GCP', 'on-premise a cloud', 'monolith a microservizi', 'REST a gRPC'])} per ridurre i costi del ${num(20,40)}%. Non puoi fare più di ${num(1,2)} cose bene. Come allochi?`,
    ],
    prediction_uncertainty: [
      () => `Il CTO deve scegliere lo stack per un nuovo prodotto che vivrà ${num(5,10)} anni. Le opzioni: (A) ${pick(['React', 'Vue', 'Svelte', 'Solid'])} + ${pick(['Node.js', 'Deno', 'Bun'])} — mainstream oggi ma potrebbe essere legacy tra 5 anni, (B) ${pick(['Rust + WASM', 'Go + HTMX', 'Elixir + LiveView', 'Kotlin Multiplatform'])} — promettente ma ecosistema immaturo, (C) stack enterprise tradizionale (${pick(['Java Spring', '.NET', 'Rails'])}) — boring but reliable. Il team di ${num(3,15)} persone ha esperienza solo nell'opzione A. Cosa scegli e come giustifichi la scommessa tecnologica?`,
    ],
    diagnosis_ambiguity: [
      () => `Un'applicazione in produzione con ${num(10,100)}K utenti simultanei mostra latenza intermittente: il p99 passa da ${num(50,200)}ms a ${num(2,10)}s per ${num(5,30)} minuti, ${num(2,5)} volte al giorno, a orari apparentemente casuali. Le cause possibili: (A) garbage collection pauses del JVM, (B) noisy neighbor su cloud condiviso, (C) connection pool exhaustion verso il database, (D) cold starts di un servizio downstream, (E) DNS resolution timeout intermittente. Hai ${num(3,7)} giorni per diagnosticare e risolvere prima del go-live di un cliente da ${num(500,5000)}K€/anno. Come procedi?`,
    ],
    ethical_dilemma: [
      () => `Scopri che il codebase del tuo prodotto SaaS (${num(10,50)}K clienti) contiene un dark pattern: il flow di cancellazione abbonamento ha ${num(5,8)} step, il bottone "annulla" è in grigio chiaro su bianco, e il ${num(40,70)}% degli utenti che iniziano la cancellazione la abbandonano. Questo dark pattern genera ${num(200,800)}K€/anno di revenue "salvata". Il product manager lo difende come "retention UX". Rimuoverlo significherebbe perdere ${num(5,15)}% del revenue annuo. Cosa fai?`,
    ],
  },

  // ========== DEVOPS ==========
  devops: {
    technical_disagreement: [
      () => `Kubernetes vs ${pick(['Nomad', 'Docker Swarm', 'ECS', 'bare metal + systemd'])} per orchestrare ${num(20,200)} servizi in produzione. K8s offre ecosistema maturo ma richiede ${num(2,5)} persone dedicate e aggiunge ${num(15,30)}% di overhead infrastrutturale. L'alternativa è più semplice ma con meno tooling. Il team DevOps è di ${num(2,8)} persone. Il downtime costa ${num(10,100)}K€/ora. Cosa scegli?`,
      () => `GitOps (ArgoCD/Flux) vs pipeline CI/CD tradizionale (Jenkins/GitLab CI) per ${num(10,100)} microservizi con ${num(5,50)} deploy/giorno. GitOps offre drift detection e rollback declarativo ma richiede che tutto sia in Git, incluse configurazioni sensibili. La pipeline tradizionale è flessibile ma meno auditabile. Il team ha ${num(0,1)} persone che conoscono GitOps. Qual è l'approccio corretto?`,
    ],
    risk_assessment: [
      () => `Una migrazione da ${pick(['on-premise', 'data center proprietario', 'cloud provider A'])} a ${pick(['AWS', 'GCP', 'Azure'])} per ${num(50,500)} servizi. Strategia lift-and-shift (${num(3,6)} mesi, ${num(200,500)}K€) vs re-architect cloud-native (${num(12,24)} mesi, ${num(500,2000)}K€). Il lift-and-shift funziona subito ma non sfrutta il cloud e costa ${num(30,60)}% in più di infrastruttura. Il re-architect è rischioso ma riduce i costi operativi del ${num(40,60)}%. L'attuale infrastruttura ha ${num(1,3)} anni di vita utile residua. Come pianifichi?`,
    ],
    values_tradeoff: [
      () => `Feature flags e canary deployments permettono release graduali ma aggiungono complessità al codice e ${num(15,30)}% di tempo di sviluppo. Senza di essi, un deploy difettoso impatta ${num(100,100000)} utenti immediatamente. Il management vuole velocità di rilascio (${num(5,20)} deploy/giorno). L'engineering vuole safety (${num(1,3)} deploy/giorno con canary al ${num(1,10)}%). Il last incident ha causato ${num(2,48)} ore di downtime e ${num(50,500)}K€ di perdite. Come bilanci velocity vs safety?`,
    ],
    resource_allocation: [
      () => `Budget infrastruttura di ${num(200,1000)}K€/anno. La spesa attuale: ${num(40,60)}% compute, ${num(15,25)}% storage, ${num(10,20)}% networking, ${num(5,15)}% monitoring. Il CTO chiede di ridurre del ${num(20,40)}%. Le opzioni: (A) spot instances per workload non-critici (-${num(30,60)}% compute ma rischio interruzioni), (B) eliminare ambienti staging (rischio qualità), (C) ridurre retention dei log da ${num(90,365)} a ${num(7,30)} giorni, (D) migrare a servizi managed (costo maggiore ma meno ops). Dove tagli?`,
    ],
    strategy_choice: [
      () => `Platform engineering interno vs tool SaaS per developer experience. Costruire un Internal Developer Platform (IDP) richiede ${num(3,8)} engineer per ${num(12,24)} mesi. Usare Backstage + tool SaaS (Datadog, PagerDuty, LaunchDarkly) costa ${num(100,500)}K€/anno ma è operativo in ${num(1,3)} mesi. L'organizzazione ha ${num(30,300)} sviluppatori. L'IDP promette ${num(20,40)}% di productivity gain ma è un investimento rischioso. Cosa scegli?`,
    ],
    diagnosis_ambiguity: [
      () => `Il deploy delle ${num(14,18)}:00 ha causato un aumento del ${num(200,500)}% degli errori 5xx. Sono stati deployati ${num(3,8)} servizi simultaneamente. Il rollback del servizio A non risolve. Il rollback del servizio B non risolve. Il rollback di tutti risolve parzialmente (errori calano del ${num(50,80)}%). Sembra un'interazione tra modifiche. Hai ${num(3,6)} servizi sospetti, ${num(1000,10000)} righe di log/minuto, e il CEO chiede aggiornamenti ogni ${num(15,30)} minuti. Come isoli la causa?`,
    ],
    prediction_uncertainty: [
      () => `L'infrastruttura attuale su ${pick(['AWS', 'GCP', 'Azure'])} costa ${num(50,300)}K€/mese e cresce del ${num(5,15)}% mese su mese. Al ritmo attuale, in ${num(12,24)} mesi supererà il budget. Le opzioni: (A) ottimizzare l'esistente (reserved instances, right-sizing) — saving stimato ${num(15,30)}% ma richiede ${num(2,6)} mesi di lavoro, (B) multi-cloud per sfruttare la concorrenza — saving ${num(10,25)}% ma complessità operativa doppia, (C) repatriare i workload pesanti on-premise — CAPEX di ${num(200,800)}K€ ma OPEX ridotto del ${num(40,60)}%. Quale strategia a ${num(3,5)} anni?`,
    ],
    ethical_dilemma: [
      () => `Durante un postmortem scopri che un collega senior ha deliberatamente bypassato la review di sicurezza per un deploy urgente ${num(2,4)} settimane fa. Il deploy ha introdotto una vulnerabilità che fortunatamente non è stata sfruttata. Il collega è una persona chiave del team (${num(8,15)} anni di esperienza) e ha agito sotto pressione del management per rispettare una deadline commerciale. Segnalarlo potrebbe costargli il lavoro. Non segnalarlo mette a rischio la cultura di sicurezza. Come gestisci la situazione?`,
    ],
  },

  // ========== AI/ML ==========
  ai_ml: {
    values_tradeoff: [
      () => `Un modello di screening medico ha accuracy del ${num(92,98)}% ma un bias razziale: funziona ${num(5,15)}% peggio su pazienti di etnia ${pick(['afroamericana', 'ispanica', 'asiatica', 'nativa americana'])}. Correggere il bias riduce l'accuracy generale al ${num(85,93)}%. Il dataset di training ha ${num(60,80)}% di pazienti caucasici. Le opzioni: (A) deploy con bias noto e disclaimer, (B) ricollezionare dati per ${num(12,24)} mesi (nel frattempo ${num(1000,10000)} pazienti non avranno accesso allo screening AI), (C) deploy con post-hoc calibration (riduce bias del ${num(50,70)}% ma non lo elimina). Cosa fai?`,
      () => `Un LLM enterprise deve scegliere tra: (A) modello closed-source (GPT-4/Claude) — migliore qualità, ma i dati aziendali transitano su server terzi e il vendor può cambiare pricing/policy, oppure (B) modello open-source self-hosted (Llama/Qwen/Mistral) — ${num(10,30)}% inferiore in benchmark ma pieno controllo, costi di GPU di ${num(50,300)}K€/anno. L'azienda tratta dati ${pick(['sanitari', 'finanziari', 'legali', 'governativi', 'militari'])}. Regolamentazioni ${pick(['GDPR', 'HIPAA', 'ITAR', 'NIS2'])} applicabili. Come decidi?`,
    ],
    ethical_dilemma: [
      () => `Un sistema AI di hiring screen ${num(10,100)}K candidati/anno per una multinazionale. Analisi post-deployment mostra che: (A) riduce i tempi di hiring del ${num(40,60)}%, (B) i manager sono soddisfatti nel ${num(80,90)}% dei casi, MA (C) un audit rivela che il sistema penalizza candidati con gap nel CV (correlato con maternità, malattia, caring), curriculum da università non prestigiose (correlato con background socioeconomico), e nomi non anglosassoni (bias linguistico). Il vendor dice che "il modello riflette i pattern di hiring storici dell'azienda". Tieni il sistema, lo rimuovi, o lo modifichi?`,
      () => `Un ricercatore ha sviluppato un modello di deepfake detection con ${num(95,99)}% di accuratezza. Lo stesso modello, invertito, può generare deepfake ${num(30,60)}% più convincenti di quelli attuali. Pubblicare la ricerca aiuterebbe la difesa ma anche l'attacco. Non pubblicarla rallenta il progresso della detection. L'${pick(['esercito', 'intelligence', 'un partito politico', 'un governo autoritario'])} ha già contattato il ricercatore offrendo ${num(500,5000)}K$ per il modello. Cosa dovrebbe fare?`,
    ],
    technical_disagreement: [
      () => `Per un sistema RAG enterprise: (A) embedding-based retrieval (dense vectors, cosine similarity) con ${num(1,50)}M documenti — alta recall ma ${num(5,15)}% di hallucination rate, oppure (B) hybrid retrieval (BM25 + dense + reranker) — recall ${num(5,10)}% inferiore ma hallucination rate sotto ${num(2,5)}%, costo ${num(2,4)}x maggiore in infrastruttura. Il sistema deve rispondere a domande su ${pick(['documentazione legale', 'brevetti', 'letteratura medica', 'normative finanziarie'])} dove un errore ha conseguenze ${pick(['legali', 'cliniche', 'finanziarie', 'reputazionali'])}. Quale architettura scegli?`,
      () => `Fine-tuning vs few-shot prompting vs RAG per specializzare un LLM in ${pick(['analisi contrattuale', 'diagnosi medica', 'code review', 'compliance finanziaria', 'supporto tecnico industriale'])}. Il fine-tuning richiede ${num(5,50)}K esempi annotati (costo ${num(20,200)}K€) e rischia catastrophic forgetting. Il few-shot non richiede training ma è inconsistente. Il RAG è robusto ma aggiunge ${num(200,800)}ms di latenza. Il budget è ${num(50,500)}K€ e il deadline è ${num(2,6)} mesi. Cosa scegli?`,
    ],
    prediction_uncertainty: [
      () => `Un fondo di venture capital valuta un investimento di ${num(5,50)}M€ in una startup che promette AGI entro ${num(3,10)} anni tramite ${pick(['scaling laws', 'neuro-symbolic AI', 'world models', 'embodied AI', 'liquid neural networks'])}. I benchmark mostrano progressi del ${num(10,30)}%/anno sulla capability X, ma i critici sostengono che i benchmark non misurano vera intelligenza. Il team è forte (${num(3,8)} ex-${pick(['DeepMind', 'OpenAI', 'Google Brain', 'Meta FAIR'])}). Il rischio è binario: o ${num(10,100)}x return o zero. Come valuti l'investimento?`,
    ],
    risk_assessment: [
      () => `Un modello di credit scoring AI viene usato da ${num(5,50)} banche per decisioni di prestito. Un ricercatore esterno pubblica un paper dimostrando che il modello è vulnerabile a adversarial attacks: modificando ${num(3,7)} campi del profilo (tutti legittimi e verificabili) il punteggio aumenta di ${num(100,200)} punti. Il ${num(5,15)}% dei profili fraudolenti nel test set passa il filtro. Le banche hanno ${num(1,10)}M prestiti attivi basati su questo modello. Quanto è grave e cosa si fa?`,
    ],
    resource_allocation: [
      () => `Un team ML di ${num(3,15)} persone deve scegliere come allocare ${num(100,500)}K€ di budget GPU per il prossimo anno: (A) training di un foundation model domain-specific (${num(50,80)}% del budget, potenziale vantaggio competitivo ma rischio alto), (B) fine-tuning di modelli open-source per ${num(5,15)} use case specifici (${num(30,50)}% del budget, ROI prevedibile), (C) infrastruttura di inferenza per scalare i modelli esistenti (${num(20,40)}% del budget, revenue immediato). Il CEO vuole "un prodotto AI che faccia wow". Il CTO vuole solidità. Come dividi?`,
    ],
    strategy_choice: [
      () => `L'azienda deve scegliere la strategia AI per i prossimi ${num(3,5)} anni: (A) API-first — costruire tutto su OpenAI/Anthropic/Google APIs, veloce da lanciare (${num(1,3)} mesi) ma totale dipendenza dal vendor (pricing, policy, disponibilità), (B) open-source self-hosted — Llama/Mistral/Qwen, ${num(6,12)} mesi di setup, costi GPU di ${num(100,500)}K€/anno ma pieno controllo, (C) hybrid — API per prototipazione, graduale migrazione a self-hosted per i workload core. L'azienda è in un settore ${pick(['regolamentato', 'competitivo', 'ad alta crescita', 'con dati sensibili'])}. Qual è la strategia giusta?`,
    ],
    diagnosis_ambiguity: [
      () => `Un modello in produzione mostra un calo di performance del ${num(5,20)}% nelle ultime ${num(2,6)} settimane. Possibili cause: (A) data drift — la distribuzione dei dati in ingresso è cambiata, (B) concept drift — la relazione input-output è cambiata nel mondo reale, (C) bug nel preprocessing pipeline introdotto ${num(1,4)} settimane fa, (D) degradazione del modello per feature engineering che assume stazionarietà, (E) cambiamento nel mix di utenti (nuovi segmenti di mercato). I monitoring mostrano ${num(3,5)} metriche anomale ma non sono conclusivi. Come diagnostichi e quanto costa ogni ipotesi sbagliata?`,
    ],
  },

  // ========== MEDICINA ==========
  medicina: {
    ethical_dilemma: [
      () => `Un ospedale deve scegliere: investire ${num(1,5)}M€ in un sistema AI diagnostico che riduce errori del ${num(20,40)}% ma richiede condivisione dati sensibili dei pazienti con un cloud provider americano, oppure tenere il sistema tradizionale. Il primario vuole l'AI, il DPO si oppone per GDPR, i pazienti non sono stati consultati. Il budget non permette una soluzione on-premise. ${num(50,200)} pazienti/anno subiscono conseguenze da diagnosi errate che l'AI avrebbe evitato. Cosa deve fare l'ospedale e perché?`,
      () => `Un paziente terminale di ${num(30,60)} anni con ${pick(['cancro pancreatico', 'SLA', 'glioblastoma', 'fibrosi polmonare idiopatica'])} chiede l'accesso a una terapia sperimentale in fase ${num(1,2)} che ha mostrato risultati promettenti su ${num(5,20)} pazienti in un trial estero. L'ospedale non è un centro di sperimentazione. Il comitato etico è diviso: ${num(3,5)} membri pro (diritto del paziente), ${num(3,5)} membri contro (rischio di dare false speranze e sprecare risorse). L'assicurazione non copre. La famiglia è disposta a pagare ${num(50,200)}K€. Come si decide?`,
    ],
    values_tradeoff: [
      () => `Un sistema sanitario nazionale deve allocare ${num(100,500)}M€ di budget extra. Opzione A: screening preventivo per ${pick(['cancro al colon', 'diabete tipo 2', 'malattie cardiovascolari'])} per ${num(1,10)}M persone (riduce mortalità del ${num(10,30)}% in ${num(5,10)} anni, ma benefici dilazionati). Opzione B: ${num(5,20)} nuovi reparti di terapia intensiva (impatto immediato, salva ${num(500,2000)} vite/anno). Opzione C: ricerca su ${pick(['terapie geniche', 'vaccini personalizzati', 'organi bioingegnerizzati'])} (nessun impatto per ${num(5,15)} anni, ma potenziale rivoluzionario). Come allochi?`,
      () => `Un farmaco generico costa ${num(5,50)}€/mese e ha efficacia del ${num(60,75)}%. Un nuovo farmaco brevettato costa ${num(500,3000)}€/mese e ha efficacia del ${num(75,90)}%. Per ${pick(['ipertensione', 'depressione', 'diabete tipo 2', 'artrite reumatoide'])}, ${num(100,500)}K pazienti nel paese. Il sistema sanitario può coprire il nuovo farmaco per tutti solo rinunciando a ${pick(['screening oncologici', 'riabilitazione cardiaca', 'supporto psicologico'])} per ${num(50,200)}K altri pazienti. Come decidi la politica farmaceutica?`,
    ],
    risk_assessment: [
      () => `Un nuovo antibiotico è efficace contro ${num(3,8)} ceppi resistenti a tutti gli altri farmaci. Ma ha effetti collaterali epatici nel ${num(2,8)}% dei pazienti (vs ${num(0.5,2)}% degli antibiotici convenzionali). Usarlo liberamente potrebbe salvare ${num(1000,5000)} vite/anno ma accelererebbe lo sviluppo di resistenza (stimata in ${num(5,15)} anni). Limitarlo ai casi disperati salva meno vite oggi ma preserva l'efficacia per il futuro. La pressione clinica è forte: i medici in prima linea vedono pazienti morire per infezioni resistenti. Qual è la policy corretta?`,
    ],
    diagnosis_ambiguity: [
      () => `Paziente di ${num(35,65)} anni con ${pick(['dolore toracico', 'cefalea severa', 'dispnea acuta', 'dolore addominale'])} atipico. ECG ${pick(['normale', 'borderline', 'con lieve anomalia aspecifica'])}. Troponina ${pick(['negativa', 'borderline elevata'])}. D-dimero ${pick(['negativo', 'lievemente elevato'])}. TC torace ${pick(['nella norma', 'con piccolo nodulo incidentale'])}. Il paziente ha ${num(2,5)} fattori di rischio. L'AI diagnostica suggerisce ${num(3,5)} possibili diagnosi con probabilità tra ${num(15,35)}% e ${num(5,20)}%. Il pronto soccorso è saturo al ${num(120,180)}%. Ricoverare per osservazione (costo ${num(1000,5000)}€, occupa un letto) o dimettere con follow-up (rischio mancata diagnosi del ${num(1,5)}%)? Come ragioni?`,
    ],
    resource_allocation: [
      () => `Emergenza sanitaria: ${num(3,8)} pazienti necessitano trapianto di ${pick(['rene', 'fegato', 'cuore', 'polmone'])} ma ci sono solo ${num(1,3)} organi disponibili. I criteri in conflitto: (A) urgenza clinica — chi morirà prima senza trapianto, (B) probabilità di successo — chi ha migliore prognosi post-trapianto, (C) tempo in lista d'attesa — chi aspetta da più tempo, (D) impatto sociale — un genitore di ${num(2,4)} figli minori vs un professionista senza familiari, (E) età — ${num(25,40)} anni vs ${num(55,70)} anni. I comitati etici di ${num(3,5)} ospedali danno risposte diverse. Come si decide e chi decide?`,
    ],
    prediction_uncertainty: [
      () => `Una pandemia emergente causata da un nuovo ${pick(['coronavirus', 'virus influenzale', 'arbovirus', 'paramyxovirus'])} ha finora ${num(1000,10000)} casi confermati in ${num(3,10)} paesi. Il tasso di mortalità stimato è ${num(1,15)}% ma i dati sono incompleti. ${num(3,8)} modelli epidemiologici danno previsioni che vanno da ${num(50,500)}K a ${num(1,50)}M di casi nei prossimi ${num(6,12)} mesi. Un lockdown preventivo costerebbe ${num(1,10)} miliardi di € al mese. Non fare nulla potrebbe sovraccaricare gli ospedali in ${num(2,8)} settimane. Quale strategia raccomandate al governo?`,
    ],
    technical_disagreement: [
      () => `Per il monitoraggio continuo di pazienti ${pick(['diabetici', 'cardiopatici', 'con BPCO', 'oncologici'])} a domicilio: (A) wearable IoT (smartwatch + sensori) — dati continui, ${num(5,15)}% falsi allarmi, costo ${num(200,800)}€/paziente, ma richiede compliance del paziente e connettività, oppure (B) visite domiciliari tradizionali ${num(1,3)} volte/settimana — affidabile ma "cieco" tra le visite, costo ${num(500,2000)}€/mese/paziente in personale. Per ${num(1000,10000)} pazienti. Il sistema sanitario è sotto organico del ${num(15,30)}%. Cosa implementi?`,
    ],
    strategy_choice: [
      () => `Un ospedale deve decidere se adottare la telemedicina per il ${num(30,60)}% delle visite di follow-up. Pro: riduce le liste d'attesa del ${num(20,40)}%, risparmia ${num(500,2000)}K€/anno, migliora l'accesso per pazienti rurali. Contro: ${num(5,15)}% di diagnosi mancate per impossibilità di esame fisico, ${num(20,40)}% di pazienti anziani non hanno competenze digitali, rischio di perdere il rapporto medico-paziente. I medici sono divisi: i giovani pro, i senior contro. Come implementi?`,
    ],
  },

  // ========== ECONOMIA ==========
  economia: {
    prediction_uncertainty: [
      () => `La banca centrale deve decidere sui tassi di interesse. L'inflazione è al ${num(3,8)}%, la disoccupazione al ${num(5,12)}%, il PIL cresce al ${num(0,3)}%. Alzare i tassi di ${num(25,100)} basis points frenerebbe l'inflazione ma rischia recessione (${num(20,40)}% di probabilità stimata). Non alzarli rischia inflazione persistente. I modelli econometrici danno previsioni contrastanti: ${num(3,6)} modelli suggeriscono rialzo, ${num(2,4)} suggeriscono pausa. Il debito pubblico è al ${num(100,150)}% del PIL. Cosa raccomandi al governatore?`,
      () => `Un paese emergente con popolazione di ${num(20,100)}M deve scegliere la strategia di sviluppo per i prossimi ${num(10,20)} anni. Opzione A: industrializzazione export-led (modello asiatico), richiede ${num(10,50)} miliardi di investimenti in infrastrutture e rischia dipendenza da mercati esteri. Opzione B: economia dei servizi digitali (modello indiano/estone), richiede formazione di ${num(100,500)}K lavoratori tech e infrastruttura internet, rischia brain drain. Opzione C: economia circolare e sostenibile, crescita lenta ma resiliente. Il ${num(30,50)}% della popolazione è sotto i 25 anni. Qual è la strategia migliore?`,
    ],
    values_tradeoff: [
      () => `Tassa patrimoniale: un governo propone un'imposta del ${num(1,3)}% su patrimoni sopra ${num(1,10)}M€. I favorevoli citano: ridurrebbe il coefficiente di Gini da ${num(0.35,0.45)} a ${num(0.30,0.40)}, genererebbe ${num(5,30)} miliardi/anno di gettito. I contrari citano: rischio di fuga capitali (${num(10,30)}% dei contribuenti interessati hanno residenze alternative), costo amministrativo del ${num(5,15)}% del gettito, distorsione degli investimenti. L'${num(1,5)}% più ricco possiede il ${num(20,40)}% della ricchezza nazionale. È giusto implementarla? Con quali salvaguardie?`,
    ],
    strategy_choice: [
      () => `Un paese UE deve decidere come affrontare la deindustrializzazione: ${num(50,200)}K posti di lavoro manifatturieri persi negli ultimi ${num(5,10)} anni. Opzione A: reshoring con sussidi (${num(1,10)} miliardi/anno, protegge ${num(30,60)}K posti ma costo alto per contribuente). Opzione B: riqualificazione nella green economy (${num(2,5)} miliardi, ma transizione di ${num(3,7)} anni durante la quale i lavoratori sono senza reddito). Opzione C: reddito di base e lasciare che il mercato si adatti (${num(5,15)} miliardi/anno, moralmente divisivo). I sindacati vogliono A, gli economisti B, i movimenti sociali C. Cosa scegli?`,
    ],
    resource_allocation: [
      () => `Il governo ha ${num(10,50)} miliardi extra da spendere. Priorità in competizione: (A) sanità — liste d'attesa di ${num(6,18)} mesi per interventi non urgenti, (B) istruzione — ${num(20,40)}% degli edifici scolastici non a norma sismica, (C) infrastrutture — ${num(100,500)} ponti con manutenzione arretrata, (D) difesa — la NATO chiede ${num(2,3)}% del PIL vs l'attuale ${num(1,1.8)}%, (E) transizione energetica — target UE di -${num(40,55)}% emissioni entro ${num(2030,2035)}. I sondaggi mostrano che i cittadini priorizzano ${pick(['sanità', 'istruzione', 'sicurezza'])} ma gli esperti ${pick(['infrastrutture', 'transizione energetica', 'difesa'])}. Come allochi?`,
    ],
    risk_assessment: [
      () => `Una bolla immobiliare? I prezzi delle case sono saliti del ${num(30,80)}% in ${num(3,7)} anni, il rapporto prezzo/reddito è a ${num(8,15)}x (media storica ${num(5,8)}x), i mutui rappresentano il ${num(60,80)}% del credito bancario. Ma: la domanda è sostenuta da immigrazione (${num(100,500)}K/anno), la costruzione di nuove case è al minimo storico, i tassi sono al ${num(2,5)}%. ${num(3,5)} economisti su ${num(10,15)} prevedono una correzione del ${num(10,30)}% entro ${num(1,3)} anni. Gli altri dicono che "questa volta è diverso" per ragioni strutturali. Hai ${num(100,500)}K€ risparmiati. Compri casa adesso o aspetti?`,
    ],
    ethical_dilemma: [
      () => `Un'azienda farmaceutica ha sviluppato un farmaco salvavita per una malattia rara (${num(1000,10000)} pazienti nel mondo). Il costo di sviluppo è stato ${num(500,2000)}M€. Per ripagare l'investimento il prezzo deve essere ${num(100,500)}K€/paziente/anno. Il ${num(70,90)}% dei pazienti vive in paesi a basso reddito e non può permetterselo. L'azienda ha azionisti da soddisfare. Le opzioni: (A) prezzo pieno globale, (B) tiered pricing per paese, (C) licenza volontaria ai generici (rinuncia al ${num(50,80)}% dei profitti), (D) partnership con governi/ONG. Cosa è giusto e cosa è sostenibile?`,
    ],
    technical_disagreement: [
      () => `MMT (Modern Monetary Theory) vs economia mainstream: un paese con debito al ${num(100,200)}% del PIL, valuta sovrana, e inflazione al ${num(2,5)}% deve decidere se finanziare un programma di ${num(50,200)} miliardi con: (A) emissione monetaria (MMT dice che è sostenibile finché l'inflazione è sotto controllo), (B) nuova tassazione (mainstream dice che il debito va ripagato), (C) taglio di spesa altrove. I MMT sostengono che il rischio inflazione è gestibile. I mainstream citano ${num(5,10)} casi storici di iperinflazione. Chi ha ragione in QUESTO contesto specifico?`,
    ],
    diagnosis_ambiguity: [
      () => `L'economia di un paese mostra segnali contraddittori: PIL in crescita del ${num(1,3)}%, ma ${num(3,5)} indicatori negativi (produzione industriale -${num(2,5)}%, fiducia consumatori -${num(10,20)}%, ordini all'export -${num(5,10)}%, spread obbligazionario +${num(50,150)} bps, mercato immobiliare in stallo). È: (A) un rallentamento ciclico normale, (B) l'inizio di una recessione, (C) una transizione strutturale (da manifattura a servizi), (D) effetto temporaneo di shock esterni? La politica economica corretta è radicalmente diversa per ciascuno scenario. Come diagnostichi con ${num(2,6)} mesi di dati?`,
    ],
  },

  // ========== OLEODINAMICA ==========
  oleodinamica: {
    technical_disagreement: [
      () => `Un impianto oleodinamico da ${num(100,500)} bar per una ${pick(['pressa', 'macchina CNC', 'escavatore', 'gru portuale', 'pressa per stampaggio'])} mostra ${num(3,8)}% di perdita di efficienza. Due teorie: (A) cavitazione nella pompa a pistoni assiali — i filtri in aspirazione sono da ${num(10,25)} micron e la viscosità dell'olio potrebbe essere inadeguata alla temperatura di esercizio (${num(50,80)}°C). (B) Trafilamento interno nelle valvole proporzionali — le tolleranze dopo ${num(5000,20000)} ore di funzionamento potrebbero essere fuori specifica. La sostituzione della pompa costa ${num(15,50)}K€ e richiede ${num(2,5)} giorni di fermo macchina. La sostituzione delle valvole costa ${num(5,15)}K€ e ${num(1,2)} giorni. Un fermo produttivo non programmato costa ${num(10,50)}K€/giorno. Come diagnostichi e cosa sostituisci prima?`,
    ],
    risk_assessment: [
      () => `Una centrale oleodinamica da ${num(200,600)} litri con ${num(4,12)} attuatori opera in un ambiente con temperatura ambiente variabile da ${num(-10,5)}°C a ${num(35,50)}°C. L'olio idraulico attuale (ISO VG ${pick(['32', '46', '68'])}) ha un range operativo ottimale di ${num(20,40)}°C. Fuori range: a freddo la viscosità sale causando cavitazione e usura pompe, a caldo scende causando trafilamento e surriscaldamento. Le opzioni: (A) olio sintetico multi-grade (${num(3,5)}x più costoso ma range esteso), (B) sistema di pre-riscaldamento + raffreddamento (${num(10,30)}K€ di installazione), (C) accettare ${num(10,20)}% di efficienza ridotta nelle stagioni estreme. L'impianto opera ${num(16,24)} ore/giorno, ${num(300,360)} giorni/anno. Qual è la soluzione ottimale?`,
    ],
    diagnosis_ambiguity: [
      () => `Un cilindro oleodinamico da ${num(100,250)} mm di alesaggio ha movimenti a scatti (stick-slip) sotto carico di ${num(10,50)} tonnellate. Possibili cause: (A) aria nel circuito — ma lo spurgo è stato fatto ${num(2,7)} giorni fa, (B) guarnizioni del pistone danneggiate — ma il cilindro ha solo ${num(1000,5000)} ore, (C) contaminazione dell'olio (particelle > ${num(10,25)} micron) — l'ultimo campione è di ${num(30,90)} giorni fa, (D) pressione di pilotaggio insufficiente sulla valvola direzionale, (E) rigenerazione interna nel cilindro per usura della cromatura. Il fermo costa ${num(5,20)}K€/giorno. Come procedi nella diagnosi?`,
    ],
    values_tradeoff: [
      () => `Un'azienda deve decidere se migrare un impianto oleodinamico da ${num(15,30)} anni a tecnologia elettromeccanica (servoazionamenti). La migrazione costa ${num(200,800)}K€ e richiede ${num(6,18)} mesi. L'oleodinamica funziona ancora ma: manutenzione ${num(30,80)}K€/anno crescente, ${num(3,8)} fermi non programmati/anno, ${num(2,5)} tecnici specializzati prossimi alla pensione. L'elettromeccanico riduce manutenzione del ${num(60,80)}% e consumi energetici del ${num(30,50)}%, ma non gestisce gli stessi carichi impulsivi. La produzione non può fermarsi per più di ${num(1,4)} settimane consecutive. Come pianifichi la transizione?`,
    ],
    strategy_choice: [
      () => `Per un nuovo impianto di ${pick(['stampaggio', 'piegatura', 'tranciatura', 'fucinatura'])} con forza di ${num(100,2000)} tonnellate: sistema oleodinamico convenzionale (affidabile, costo ${num(100,300)}K€, ma consumo energetico alto e manutenzione) vs sistema ibrido oleodinamico-elettrico (servo-pompa a velocità variabile, ${num(30,50)}% in più di costo, ma ${num(40,60)}% di risparmio energetico). L'energia costa ${num(0.15,0.30)}€/kWh e l'impianto opera ${num(4000,7000)} ore/anno. Il payback del sistema ibrido è stimato in ${num(2,5)} anni. Ma l'ibrido è più complesso: richiede ${pick(['personale formato', 'pezzi di ricambio specifici', 'software di controllo proprietario'])}. Quale scegli?`,
    ],
    resource_allocation: [
      () => `Budget manutenzione di ${num(100,300)}K€/anno per ${num(10,30)} impianti oleodinamici di diverse età (${num(2,25)} anni). Devi allocare tra: (A) manutenzione predittiva — analisi olio trimestrali, sensori vibrazione, termografia (${num(30,60)}K€/anno, riduce fermi del ${num(40,60)}%), (B) stock ricambi critici — pompe, valvole, guarnizioni (${num(40,80)}K€ immobilizzati, riduce tempi di fermo da ${num(3,10)} giorni a ${num(1,2)} giorni), (C) sostituzione programmata dei ${num(2,5)} impianti più vecchi (${num(50,150)}K€/anno). Non puoi fare tutto. Come allochi?`,
    ],
    prediction_uncertainty: [
      () => `Un impianto oleodinamico critico per la produzione (fatturato impattato: ${num(1,10)}M€/anno) mostra trend di degrado nei dati della manutenzione predittiva: contaminazione olio in aumento (${num(5,15)}% sopra NAS ${num(7,9)} target), temperatura operativa media salita di ${num(3,8)}°C in ${num(6,12)} mesi, vibrazioni pompa incrementate del ${num(10,25)}%. I modelli predittivi stimano guasto tra ${num(2,12)} mesi con intervallo di confidenza del ${num(50,80)}%. Una revisione completa preventiva costa ${num(20,80)}K€ e ${num(3,7)} giorni di fermo. Un guasto non programmato costerebbe ${num(50,200)}K€ e ${num(7,21)} giorni. Quando intervieni?`,
    ],
    ethical_dilemma: [
      () => `Un tecnico di manutenzione scopre che un impianto oleodinamico in una fabbrica ha una perdita di olio minerale di ${num(5,20)} litri/mese che finisce nel terreno sottostante. L'olio contiene ${pick(['additivi con zinco', 'composti organici volatili', 'metalli pesanti da usura'])}. Segnalarlo significherebbe: fermo produttivo di ${num(2,8)} settimane per bonifica (costo ${num(50,200)}K€), possibili sanzioni ambientali fino a ${num(100,500)}K€, rischio di licenziamento del responsabile manutenzione (che è il suo capo diretto e ha ${num(2,4)} figli). Non segnalarlo è un reato ambientale. Il proprietario dell'azienda è noto per vendicarsi contro i whistleblower. Cosa fa il tecnico?`,
    ],
  },

  // ========== PNEUMATICA ==========
  pneumatica: {
    technical_disagreement: [
      () => `Per un impianto di automazione con ${num(50,200)} attuatori pneumatici: aria compressa centralizzata (compressore da ${num(15,75)} kW, rete di distribuzione da ${num(100,500)} metri, pressione ${num(6,10)} bar) vs compressori decentralizzati nelle isole (${num(5,15)} compressori piccoli, nessuna rete, ma manutenzione moltiplicata). L'impianto centralizzato ha perdite stimate del ${num(15,30)}% nella rete (giunti, raccordi, tubi), ma è più efficiente a pieno carico. I decentralizzati non hanno perdite di rete ma ciascuno opera al ${num(30,60)}% di efficienza. Costo energetico: ${num(50,200)}K€/anno. Quale topologia scegli?`,
    ],
    values_tradeoff: [
      () => `Pneumatica vs elettrica per un impianto di ${pick(['packaging', 'assemblaggio', 'palettizzazione', 'sorting'])} con ${num(100,500)} cicli/minuto. I cilindri pneumatici sono semplici, affidabili, resistenti ad ambienti ${pick(['umidi', 'polverosi', 'ATEX', 'alimentari'])} ma consumano ${num(3,5)}x più energia degli azionamenti elettrici equivalenti. Gli attuatori elettrici offrono posizionamento preciso e controllo di forza ma costano ${num(2,4)}x in più e richiedono competenze diverse. L'impianto deve operare ${num(16,24)}/7 per i prossimi ${num(10,15)} anni. L'energia costa ${num(0.15,0.30)}€/kWh. Quale tecnologia e perché?`,
    ],
    diagnosis_ambiguity: [
      () => `Un sistema pneumatico di ${num(20,60)} cilindri in un impianto di assemblaggio mostra tempi ciclo aumentati del ${num(15,30)}%. Le cause possibili: (A) calo pressione di rete (da ${num(6,8)} a ${num(4.5,6)} bar) per aumento utenze senza adeguamento compressore, (B) filtri FRL intasati (ultimo cambio: ${num(6,18)} mesi fa), (C) regolatori di flusso disregolati dopo manutenzione, (D) trafilamento nelle guarnizioni dei cilindri più vecchi, (E) condensazione nel circuito per essiccatore malfunzionante. Ogni causa richiede un intervento diverso e il costo del fermo è ${num(5,20)}K€/giorno. Come sistematizzi la diagnosi?`,
    ],
    resource_allocation: [
      () => `Un impianto pneumatico con costo energetico di ${num(80,250)}K€/anno per l'aria compressa. Un audit energetico rivela: ${num(20,35)}% di perdite nella rete, ${num(15,25)}% di sovrappressione (si lavora a ${num(7,8)} bar quando basterebbero ${num(5,6)} bar per il ${num(60,80)}% delle utenze), ${num(10,20)}% di spreco per soffiatori usati impropriamente. Budget per efficientamento: ${num(30,80)}K€. Opzioni: (A) riparazione perdite (saving ${num(15,30)}%), (B) rete a doppia pressione (saving ${num(10,20)}% ma investimento maggiore), (C) sostituzione soffiatori con ugelli Venturi (saving ${num(5,10)}%), (D) sistema di gestione e monitoraggio IoT (saving ${num(5,15)}%). Come allochi i ${num(30,80)}K€?`,
    ],
    risk_assessment: [
      () => `Un impianto pneumatico in zona ${pick(['ATEX', 'classificata', 'a rischio esplosione'])} usa componenti certificati ATEX Cat. ${pick(['1', '2', '3'])}. Un fornitore propone componenti alternativi al ${num(30,50)}% in meno di costo ma con certificazione da un ente di un paese ${pick(['extra-UE', 'non riconosciuto mutualmente', 'con standard diversi'])}. Il risparmio annuo sarebbe di ${num(20,60)}K€. Il rischio: se un componente causa una scintilla in atmosfera esplosiva, le conseguenze sono ${pick(['letali', 'catastrofiche', 'distruttive'])}. L'assicurazione potrebbe non coprire con componenti non conformi. Il procurement spinge per il risparmio, la sicurezza dice no. Chi ha ragione?`,
    ],
    prediction_uncertainty: [
      () => `Un compressore a vite da ${num(30,100)} kW con ${num(20000,50000)} ore di funzionamento. Il costruttore raccomanda revisione generale a ${num(30000,40000)} ore (costo ${num(5,15)}K€, fermo ${num(3,5)} giorni). Il compressore attualmente funziona bene ma: la temperatura dell'olio è salita di ${num(5,10)}°C negli ultimi ${num(6,12)} mesi, il consumo energetico è aumentato del ${num(3,8)}%, le vibrazioni sono nella norma ma in trend crescente. Un guasto catastrofico significherebbe fermo produttivo di ${num(1,3)} settimane (costo ${num(20,100)}K€) e sostituzione del compressore (${num(30,100)}K€). Fai la revisione ora (anticipata) o aspetti?`,
    ],
    strategy_choice: [
      () => `Transizione dall'aria compressa al vuoto per un sistema di presa e manipolazione con ${num(20,80)} ventose. L'aria compressa attuale (generatori venturi) consuma ${num(30,70)}% più energia di una pompa del vuoto centralizzata. Ma: la pompa centralizzata (${num(15,40)}K€) ha un singolo punto di guasto, richiede tubazione del vuoto dedicata, e il tempo di risposta è maggiore (${num(50,200)}ms vs ${num(10,30)}ms dei venturi). Il sistema gestisce pezzi da ${num(0.1,50)} kg e un pezzo perso causa ${num(500,5000)}€ di danno (pezzo + fermo). Come decidi?`,
    ],
    ethical_dilemma: [
      () => `Un ispettore di sicurezza scopre che ${num(3,8)} cilindri pneumatici in un impianto lavorano oltre la pressione nominale (${num(8,12)} bar su cilindri certificati per ${num(6,10)} bar) perché un tecnico ha bypassato i limitatori per "velocizzare la produzione". Il capo produzione era a conoscenza e ha tollerato la modifica per ${num(6,18)} mesi perché la produttività è aumentata del ${num(10,20)}%. Non ci sono stati incidenti ma il rischio di rottura esplosiva di un cilindro in sovrappressione è calcolato nel ${num(0.1,1)}%/anno per cilindro. L'ispettore lavora per una ditta esterna e il suo contratto dipende dal cliente. Cosa fa?`,
    ],
  },

  // ========== MECCANICA INDUSTRIALE ==========
  meccanica_industriale: {
    technical_disagreement: [
      () => `Per un cuscinetto su un albero da ${num(50,200)} mm di diametro, rotazione a ${num(1000,10000)} RPM, carico radiale di ${num(5,50)} kN e assiale di ${num(1,20)} kN: cuscinetto a rulli conici (maggiore capacità di carico ma attrito più alto e necessità di precarico preciso) vs cuscinetto a rulli cilindrici + reggispinta separato (più costoso e ingombrante ma singolarmente più efficiente). La temperatura operativa è ${num(60,120)}°C e la lubrificazione è ${pick(['a grasso', 'a olio', 'a bagno d\'olio', 'a circolazione forzata'])}. La vita attesa è ${num(20000,100000)} ore. Quale soluzione e quale lubrificazione?`,
    ],
    values_tradeoff: [
      () => `Un impianto di produzione con ${num(5,20)} macchine CNC di ${num(10,20)} anni deve decidere tra: (A) retrofit con controlli numerici moderni (costo ${num(30,80)}K€/macchina, mantiene la meccanica esistente, operativo in ${num(2,4)} settimane/macchina), (B) sostituzione con macchine nuove (costo ${num(150,500)}K€/macchina, ${num(3,6)} mesi di lead time, prestazioni superiori del ${num(30,50)}%). Il fatturato attuale è di ${num(2,10)}M€/anno. Le macchine attuali producono con tolleranze di ${num(0.01,0.05)} mm, le nuove arriverebbero a ${num(0.002,0.01)} mm. Ma il ${num(60,80)}% dei lavori attuali non richiede tolleranze così strette. Come decidi?`,
    ],
    diagnosis_ambiguity: [
      () => `Una macchina utensile a ${num(3,5)} assi produce pezzi con errore dimensionale di ${num(0.02,0.1)} mm su una quota critica (tolleranza ${num(0.01,0.05)} mm). L'errore è apparso ${num(1,4)} settimane fa. Cause possibili: (A) usura del mandrino (gioco radiale), (B) errore di compensazione termica (la macchina lavora ${num(16,24)}/7 senza pause), (C) utensile con geometria degradata, (D) errore nel post-processore CAM dopo aggiornamento software, (E) deformazione della struttura per cedimento di un fondamento. Ogni verifica richiede ${num(2,8)} ore e il fermo costa ${num(3,15)}K€/giorno. Ordine di diagnosi ottimale?`,
    ],
    risk_assessment: [
      () => `Una catena di montaggio con ${num(20,100)} stazioni usa riduttori epicicloidali ad alta precisione (gioco < ${num(1,5)} arcmin). ${num(3,8)} riduttori hanno raggiunto il ${num(80,95)}% della vita calcolata (${num(15000,40000)} ore). La sostituzione preventiva di tutti costa ${num(30,100)}K€ e ${num(3,7)} giorni di fermo. Un guasto in linea costa ${num(10,40)}K€/giorno e il lead time per un riduttore nuovo è ${num(4,12)} settimane. L'analisi delle vibrazioni mostra che ${num(1,3)} riduttori hanno trend anomali ma non critici. Sostituisci tutti, solo quelli anomali, o aspetti il guasto?`,
    ],
    resource_allocation: [
      () => `Un'officina meccanica con ${num(5,15)} operatori e ${num(8,25)} macchine deve investire ${num(100,500)}K€. Opzioni: (A) robot collaborativo per asservimento macchine (libera ${num(1,3)} operatori per lavori a maggior valore), (B) nuovo centro di lavoro 5 assi (apre nuovi mercati high-tech), (C) sistema MES per pianificazione e tracking (riduce tempi non produttivi del ${num(15,30)}%), (D) formazione avanzata per ${num(3,8)} operatori. Il mercato attuale è ${num(50,80)}% componentistica automotive con margini in calo del ${num(5,10)}%/anno. Come investi?`,
    ],
    strategy_choice: [
      () => `Manifattura additiva (stampa 3D metallo) vs lavorazione tradizionale per la produzione di ${num(50,500)} pezzi/anno di un componente complesso in ${pick(['titanio', 'Inconel', 'acciaio inox 316L', 'alluminio AlSi10Mg'])}. L'additiva: nessun attrezzaggio (saving ${num(20,80)}K€), geometrie impossibili con il tradizionale, ma costo/pezzo ${num(2,5)}x maggiore, proprietà meccaniche variabili, necessità di post-lavorazione e trattamento termico. Certificazione: il cliente è nel settore ${pick(['aerospaziale', 'medicale', 'nucleare', 'oil & gas'])} e richiede ${pick(['EN 9100', 'ISO 13485', 'ASME BPVC', 'API'])}. Quale processo scegli?`,
    ],
    prediction_uncertainty: [
      () => `Un componente meccanico in ${pick(['acciaio armonico', 'ghisa sferoidale', 'lega di alluminio 7075', 'titanio Ti-6Al-4V'])} è soggetto a fatica ciclica con ${num(1000,10000)} cicli/giorno a tensione variabile (${num(50,80)}% del limite di snervamento). I test di fatica mostrano vita media di ${num(100,500)}K cicli con deviazione standard del ${num(20,40)}%. Il componente è critico per la sicurezza: un guasto a fatica ha conseguenze ${pick(['gravi per la sicurezza degli operatori', 'di fermo produttivo catastrofico', 'ambientali per rilascio sostanze', 'economiche per danni a valle'])}. L'ispezione NDT costa ${num(500,3000)}€ e va fatta a macchina ferma. Ogni quanto ispezioni e quando sostituisci preventivamente?`,
    ],
    ethical_dilemma: [
      () => `Un ingegnere scopre che un lotto di ${num(100,1000)} componenti meccanici di sicurezza (${pick(['bulloni per giunti flangiati', 'alberi per gru', 'perni per impianti di sollevamento', 'cuscinetti per turbine'])}) è stato prodotto con materiale fuori specifica: la resilienza è del ${num(10,25)}% inferiore al minimo. I componenti sono già stati ${pick(['installati', 'consegnati', 'in fase di spedizione'])} a ${num(5,20)} clienti. Il richiamo costa ${num(200,800)}K€ e mette a rischio il contratto con il cliente principale (${num(1,5)}M€/anno). Il direttore qualità suggerisce di "non fare nulla perché i coefficienti di sicurezza coprono la differenza". L'ingegnere sa che i coefficienti di sicurezza NON coprono carichi impulsivi. Cosa fa?`,
    ],
  },

  // ========== AUTOMAZIONE INDUSTRIALE ==========
  automazione_industriale: {
    technical_disagreement: [
      () => `Per un impianto di automazione con ${num(10,50)} PLC e ${num(100,1000)} I/O: architettura centralizzata (PLC master + rack remoti, comunicazione ${pick(['PROFINET', 'EtherCAT', 'EtherNet/IP'])}, determinismo garantito) vs architettura distribuita (PLC edge per ogni isola, comunicazione via ${pick(['OPC UA', 'MQTT', 'TSN'])}, maggiore resilienza ma sincronizzazione più complessa). Il tempo ciclo richiesto è ${num(1,100)} ms. L'impianto è lungo ${num(50,500)} metri. Il costo del cablaggio tradizionale è ${num(20,60)}% del budget automazione. Quale architettura?`,
    ],
    values_tradeoff: [
      () => `Un impianto chimico con ${num(20,100)} loop di controllo deve aggiornare il DCS (Distributed Control System). Opzione A: upgrade del DCS proprietario esistente (${pick(['Siemens PCS7', 'ABB 800xA', 'Emerson DeltaV', 'Honeywell Experion'])}) — compatibile, vendor support, ma vendor lock-in totale e costi di licenza crescenti del ${num(5,10)}%/anno. Opzione B: migrazione a soluzione open-source/open-standard (Linux-based, OPC UA) — nessun lock-in, costo licenze zero, ma: ${num(0,2)} precedenti nel settore chimico, nessuna certificazione SIL per safety, team interno senza esperienza. L'impianto gestisce sostanze ${pick(['infiammabili', 'tossiche', 'corrosive', 'esplosive'])}. Quanto pesa il vendor lock-in vs la safety?`,
    ],
    risk_assessment: [
      () => `Un sistema SCADA industriale con ${num(5,20)} anni di vita non è mai stato aggiornato. Usa Windows ${pick(['XP', '7', 'Server 2008'])} non patchato e protocolli ${pick(['Modbus RTU', 'PROFIBUS', 'DeviceNet'])} senza autenticazione. Un audit rivela ${num(5,20)} vulnerabilità critiche (CVSS > 7). Il sistema controlla ${pick(['una rete elettrica', 'un impianto di trattamento acque', 'una catena di produzione alimentare', 'un impianto petrolchimico'])}. L'aggiornamento richiede ${num(6,18)} mesi e ${num(200,800)}K€ di fermo programmato. Un attacco potrebbe causare ${pick(['blackout', 'contaminazione idrica', 'intossicazione alimentare', 'esplosione'])}. Come prioritizzi?`,
    ],
    strategy_choice: [
      () => `Industry 4.0 per un'azienda manifatturiera con ${num(50,300)} dipendenti e fatturato di ${num(5,50)}M€. Il management vuole "digitalizzare" ma il budget è ${num(100,500)}K€. Le opzioni realistiche: (A) MES (Manufacturing Execution System) per tracciabilità e OEE — ROI misurabile in ${num(6,18)} mesi, (B) digital twin per simulazione e ottimizzazione — potenziale alto ma ROI incerto e richiede dati che non esistono ancora, (C) manutenzione predittiva con sensori IoT su ${num(5,20)} macchine critiche — ROI in ${num(12,24)} mesi, (D) cobot per asservimento — libera operatori ma richiede riprogettazione celle. Da dove parti?`,
    ],
    diagnosis_ambiguity: [
      () => `Un robot industriale a ${num(4,6)} assi ha un errore di posizionamento di ${num(0.5,3)} mm che supera la tolleranza richiesta (${num(0.1,0.5)} mm). Il robot ha ${num(10000,50000)} ore e non è mai stato calibrato. Cause possibili: (A) gioco nei riduttori Harmonic Drive, (B) errore di calibrazione kinematica (DH parameters), (C) deformazione termica della struttura, (D) encoder con risoluzione degradata, (E) deflessione sotto carico del payload da ${num(5,50)} kg. Ogni diagnosi richiede strumenti diversi (laser tracker: ${num(5000,15000)}€ di noleggio, accelerometri, termocoppie). L'errore è intermittente. Come sistematizzi?`,
    ],
    prediction_uncertainty: [
      () => `Un'azienda valuta se investire ${num(500,2000)}K€ in robotica collaborativa per una linea di assemblaggio. I cobot costano ${num(30,80)}K€ ciascuno e ne servono ${num(5,15)}. I case study del vendor promettono ROI in ${num(1,3)} anni. Ma: il ${num(30,50)}% delle installazioni di cobot nel settore non raggiunge il ROI previsto (dati di settore). I motivi: sottostima della fase di integrazione, prodotti che cambiano troppo spesso, operatori non formati. L'azienda ha ${num(50,200)} operatori, il costo del lavoro è ${num(25,40)}K€/anno/operatore. L'investimento è recuperabile se i cobot sostituiscono ${num(3,10)} operatori. Rischio calcolato o salto nel buio?`,
    ],
    resource_allocation: [
      () => `Un reparto di automazione con ${num(3,10)} ingegneri deve gestire: (A) ${num(10,30)} richieste di modifica impianti esistenti (backlog di ${num(3,12)} mesi), (B) ${num(2,5)} nuovi progetti capex approvati con deadline, (C) manutenzione software di ${num(5,20)} PLC legacy senza documentazione, (D) formazione su nuove tecnologie (${pick(['cobot', 'visione artificiale', 'TSN', 'digital twin'])}). Il ${num(30,50)}% del tempo va in "firefighting" su impianti vecchi. Il management vuole i nuovi progetti. La produzione vuole le modifiche. Come organizzi il team?`,
    ],
    ethical_dilemma: [
      () => `Un sistema di visione artificiale per il controllo qualità in una linea alimentare ha un tasso di falsi negativi dello ${num(0.5,3)}% (prodotti difettosi che passano il controllo). Questo è conforme allo standard ${pick(['IFS', 'BRC', 'ISO 22000'])} (soglia ${num(1,5)}%). Ma un ingegnere scopre che riprogrammando la soglia di sensibilità potrebbe ridurre i falsi negativi allo ${num(0.1,0.5)}%, a costo di aumentare i falsi positivi dal ${num(2,5)}% al ${num(8,15)}% (prodotti buoni scartati). Lo scarto costa ${num(50,200)}K€/anno. Il management preferisce la soglia attuale perché "è conforme". L'ingegnere sa che un prodotto difettoso potrebbe causare ${pick(['contaminazione', 'allergeni non rilevati', 'corpo estraneo'])}. Cosa fa?`,
    ],
  },
};

// ============================================================================
// Add remaining domains with cross-cutting templates
// ============================================================================

function addGenericDomainPrompts(domain, topics) {
  if (PROMPT_BANK[domain]) return; // Already defined
  PROMPT_BANK[domain] = {};
  for (const ct of CONFLICT_TYPES) {
    PROMPT_BANK[domain][ct] = topics.map(topic => {
      switch (ct) {
        case 'values_tradeoff':
          return () => `Nel campo di ${topic}, un'organizzazione deve scegliere tra ${pick(['innovazione rapida', 'qualità massima', 'riduzione costi', 'sostenibilità ambientale', 'trasparenza totale', 'protezione della privacy'])} e ${pick(['sicurezza', 'stabilità', 'profitto a breve termine', 'crescita aggressiva', 'riservatezza', 'inclusione sociale'])}. Il budget è di ${num(100,5000)}K€, il team è di ${num(5,50)} persone, e la deadline è ${num(3,18)} mesi. ${pick(['Il board è diviso', 'Gli stakeholder hanno interessi opposti', 'I clienti principali chiedono entrambe le cose', 'La regolamentazione è ambigua'])}. Come bilanci i due obiettivi?`;
        case 'technical_disagreement':
          return () => `Due esperti di ${topic} sono in disaccordo: il primo sostiene che l'approccio ${pick(['centralizzato', 'tradizionale', 'analitico', 'quantitativo', 'standardizzato'])} è superiore perché ${pick(['ha più evidenze', 'è più robusto', 'scala meglio', 'è più verificabile'])}. Il secondo propone un approccio ${pick(['distribuito', 'innovativo', 'olistico', 'qualitativo', 'adattivo'])} che ${pick(['è più flessibile', 'si adatta meglio al contesto', 'ha risultati migliori in casi recenti', 'riduce i costi del ' + num(20,50) + '%'])}. Il sistema deve servire ${num(100,10000)} utenti per ${num(3,15)} anni. Quale approccio e perché?`;
        case 'prediction_uncertainty':
          return () => `Nel settore ${topic}, ${num(3,8)} scenari futuri sono plausibili entro ${num(3,10)} anni. Lo scenario ottimistico prevede crescita del ${num(20,50)}%, il pessimistico un declino del ${num(10,30)}%, e ${num(1,6)} scenari intermedi con probabilità stimate tra ${num(10,30)}%. Una decisione strategica da ${num(100,5000)}K€ deve essere presa ora. La decisione ottimale è radicalmente diversa per ciascuno scenario. I dati disponibili coprono solo ${num(2,5)} anni di storico. Come decidi sotto questa incertezza?`;
        case 'ethical_dilemma':
          return () => `In ${topic}: un professionista scopre che una pratica comune nel settore causa ${pick(['danni ambientali nascosti', 'rischi per la salute sottostimati', 'discriminazione indiretta', 'perdite finanziarie ai consumatori', 'erosione della privacy'])}. Denunciare significherebbe ${pick(['perdere il lavoro', 'danneggiare il settore', 'violare NDA', 'mettere a rischio colleghi'])}. Non denunciare significa essere complici. Le ${num(3,8)} persone che sanno sono tutte in posizioni vulnerabili. La regolamentazione non copre specificamente questo caso. Esiste una terza via?`;
        case 'resource_allocation':
          return () => `Un'organizzazione nel campo ${topic} ha ${num(50,500)}K€ di budget e ${num(3,5)} progetti in competizione, ognuno con ROI stimato diverso ma con incertezza alta. Il progetto A ha ROI ${num(150,300)}% ma rischio del ${num(30,50)}%, il B ha ROI ${num(80,150)}% con rischio ${num(10,20)}%, il C è necessario per compliance (nessun ROI diretto, penale di ${num(50,500)}K€ se non fatto). Non puoi finanziare tutti. Come allochi?`;
        case 'risk_assessment':
          return () => `Nel campo ${topic}, un evento a bassa probabilità (${num(1,10)}% nei prossimi ${num(1,5)} anni) ma alto impatto (${num(500,5000)}K€ di danno) richiede una decisione: investire ${num(50,200)}K€ in prevenzione che riduce la probabilità del ${num(50,80)}%, oppure accettare il rischio e investire in capacità di risposta (${num(20,80)}K€) che riduce l'impatto del ${num(30,60)}%. Il management è diviso tra prevenzione e reazione. I dati storici sono insufficienti (${num(2,5)} eventi simili in ${num(10,20)} anni di storia). Come valuti?`;
        case 'strategy_choice':
          return () => `Nel settore ${topic}, un'organizzazione deve scegliere tra ${num(3,4)} strategie mutuamente esclusive per i prossimi ${num(2,5)} anni. La strategia conservativa protegge il ${num(70,90)}% del business attuale ma non cresce. La strategia aggressiva potrebbe raddoppiare il fatturato ma con ${num(30,50)}% di probabilità di fallimento. La strategia ibrida è un compromesso con risultati mediocri ma rischio basso. Una quarta opzione è "pivot" totale verso un segmento adiacente. Il mercato attuale sta cambiando a causa di ${pick(['digitalizzazione', 'regolamentazione', 'nuovi competitor', 'cambiamento demografico'])}. Quale strategia?`;
        case 'diagnosis_ambiguity':
          return () => `In ${topic}, un sistema mostra ${num(3,6)} sintomi apparentemente correlati ma che potrebbero avere ${num(3,5)} cause radice diverse. La causa A spiega ${num(2,4)} sintomi ma non tutti. La causa B spiega un solo sintomo ma è la più grave. La causa C spiegherebbe tutti i sintomi ma è la meno probabile (${num(5,15)}%). Ogni diagnosi errata costa ${num(10,100)}K€ e ${num(1,4)} settimane di ritardo. I test diagnostici disponibili sono ${num(2,4)}, ognuno costa ${num(1,10)}K€ e richiede ${num(1,5)} giorni. Come ottimizzi la sequenza diagnostica?`;
        default:
          return () => `In ${topic}: valuta i pro e contro di due approcci contrastanti con vincoli di budget ${num(50,500)}K€ e tempo ${num(3,12)} mesi.`;
      }
    });
  }
}

// Add all missing domains
const GENERIC_TOPICS = {
  data_engineering: ['data pipeline design', 'data warehouse vs data lake', 'real-time vs batch processing', 'data quality governance'],
  cloud_infrastructure: ['multi-cloud strategy', 'serverless architecture', 'container orchestration', 'edge computing'],
  frontend_engineering: ['framework selection', 'server-side rendering vs SPA', 'design system architecture', 'accessibility compliance'],
  database_systems: ['database selection', 'sharding strategy', 'CAP theorem tradeoffs', 'migration planning'],
  distributed_systems: ['consensus protocol selection', 'consistency vs availability', 'service mesh architecture', 'event-driven design'],
  networking: ['network architecture', 'SD-WAN vs traditional', 'zero trust networking', 'IoT network design'],
  elettronica: ['analog vs digital design', 'FPGA vs ASIC', 'power management', 'EMC compliance'],
  ingegneria_civile: ['structural design methods', 'seismic retrofitting', 'sustainable construction', 'bridge engineering'],
  ingegneria_energetica: ['renewable energy integration', 'grid modernization', 'energy storage', 'smart grid design'],
  compliance_gdpr: ['data processing agreements', 'cross-border data transfers', 'privacy by design', 'data breach response'],
  regolamentazione_ai: ['AI Act compliance', 'algorithmic accountability', 'AI risk classification', 'automated decision-making'],
  diritto_lavoro: ['remote work regulations', 'algorithmic management', 'gig economy classification', 'workplace surveillance'],
  proprieta_intellettuale: ['patent strategy', 'open source licensing', 'trade secret protection', 'AI-generated content ownership'],
  contrattualistica: ['SaaS contract negotiation', 'liability clauses', 'force majeure', 'vendor management'],
  diritto_penale_informatico: ['cybercrime prosecution', 'digital evidence', 'cross-border jurisdiction', 'AI-assisted crime'],
  finanza: ['portfolio optimization', 'risk management', 'fintech regulation', 'ESG investing'],
  strategia_aziendale: ['market entry strategy', 'competitive positioning', 'M&A evaluation', 'digital transformation'],
  marketing: ['brand positioning', 'AI in marketing', 'privacy-first marketing', 'B2B vs B2C strategy'],
  supply_chain: ['supply chain resilience', 'just-in-time vs just-in-case', 'supplier diversification', 'logistics optimization'],
  hr_management: ['talent acquisition', 'AI in HR', 'remote team management', 'compensation strategy'],
  startup_strategy: ['fundraising timing', 'pivot decision', 'scaling strategy', 'product-market fit'],
  farmacologia: ['drug development pipeline', 'personalized medicine', 'clinical trial design', 'pharmacovigilance'],
  sanita_pubblica: ['pandemic preparedness', 'vaccination strategy', 'health equity', 'mental health policy'],
  neuroscienze: ['brain-computer interfaces', 'consciousness theories', 'neuroplasticity applications', 'cognitive enhancement'],
  bioetica: ['genetic engineering ethics', 'end-of-life decisions', 'organ allocation', 'human enhancement'],
  genetica: ['gene therapy', 'genetic screening', 'CRISPR applications', 'biobank governance'],
  energia: ['energy transition', 'nuclear vs renewable', 'hydrogen economy', 'energy efficiency policy'],
  ambiente: ['biodiversity conservation', 'circular economy', 'pollution control', 'environmental impact assessment'],
  sostenibilita: ['sustainable development', 'carbon neutrality', 'green finance', 'sustainable supply chains'],
  climate_policy: ['carbon pricing', 'climate adaptation', 'geoengineering', 'just transition'],
  filosofia: ['philosophy of mind', 'free will', 'ethics of technology', 'epistemology of AI'],
  etica: ['applied ethics', 'moral dilemmas', 'corporate ethics', 'research ethics'],
  epistemologia: ['knowledge validation', 'scientific method', 'epistemic uncertainty', 'truth in post-truth era'],
  psicologia: ['cognitive biases', 'decision psychology', 'organizational psychology', 'therapy approaches'],
  sociologia: ['social inequality', 'digital society', 'institutional change', 'collective behavior'],
  decision_making: ['decision under uncertainty', 'group decision dynamics', 'cognitive biases in decisions', 'multi-criteria decision analysis'],
  pedagogia: ['educational technology', 'inclusive education', 'assessment methods', 'lifelong learning'],
  geopolitica: ['great power competition', 'regional conflicts', 'economic warfare', 'technology sovereignty'],
  diplomazia: ['multilateral negotiations', 'conflict resolution', 'diplomatic immunity', 'international law'],
  politica_internazionale: ['international institutions', 'global governance', 'humanitarian intervention', 'sanctions policy'],
  governance: ['digital governance', 'regulatory design', 'public-private partnerships', 'transparency mechanisms'],
  urbanistica: ['smart city design', 'affordable housing', 'urban mobility', 'green infrastructure'],
  trasporti: ['autonomous vehicles', 'public transit optimization', 'freight decarbonization', 'last-mile logistics'],
  infrastruttura_critica: ['infrastructure resilience', 'aging infrastructure', 'cybersecurity of critical systems', 'public-private ownership'],
  logistica: ['warehouse automation', 'route optimization', 'reverse logistics', 'cold chain management'],
  agricoltura: ['precision agriculture', 'organic vs conventional', 'water management', 'food security'],
  alimentazione: ['food safety systems', 'nutritional policy', 'food waste reduction', 'alternative proteins'],
  biotecnologie: ['synthetic biology', 'biomanufacturing', 'gene editing regulation', 'bioeconomy strategy'],
  comunicazione: ['crisis communication', 'internal communications', 'stakeholder engagement', 'narrative strategy'],
  brand_strategy: ['brand architecture', 'rebranding', 'brand authenticity', 'purpose-driven branding'],
  crisis_management: ['crisis response planning', 'reputation recovery', 'business continuity', 'stakeholder communication during crisis'],
};

for (const [domain, topics] of Object.entries(GENERIC_TOPICS)) {
  addGenericDomainPrompts(domain, topics);
}

// ============================================================================
// GENERATION
// ============================================================================

function generatePrompts(target = 2000) {
  const prompts = [];
  const domainCounts = {};
  const conflictCounts = {};
  const difficultyCounts = { easy: 0, medium: 0, hard: 0, extreme: 0 };

  // Difficulty distribution: 10% easy, 20% medium, 30% hard, 40% extreme
  function pickDifficulty() {
    const r = Math.random();
    if (r < 0.10) return 'easy';
    if (r < 0.30) return 'medium';
    if (r < 0.60) return 'hard';
    return 'extreme';
  }

  // Round-robin across domains for even distribution
  const domainKeys = Object.keys(PROMPT_BANK);
  let domainIdx = 0;
  let conflictIdx = 0;

  // Track used prompt texts to ensure uniqueness
  const usedPrompts = new Set();

  let attempts = 0;
  const maxAttempts = target * 10;

  while (prompts.length < target && attempts < maxAttempts) {
    attempts++;
    const domain = domainKeys[domainIdx % domainKeys.length];
    domainIdx++;

    const conflict = CONFLICT_TYPES[conflictIdx % CONFLICT_TYPES.length];
    conflictIdx++;

    const generators = PROMPT_BANK[domain]?.[conflict];
    if (!generators || generators.length === 0) continue;

    const generator = pick(generators);
    const promptText = generator();

    // Ensure uniqueness
    if (usedPrompts.has(promptText)) continue;
    usedPrompts.add(promptText);

    const difficulty = pickDifficulty();

    prompts.push({
      id: prompts.length + 1,
      prompt: promptText,
      domain,
      difficulty,
      conflict_type: conflict,
    });

    domainCounts[domain] = (domainCounts[domain] || 0) + 1;
    conflictCounts[conflict] = (conflictCounts[conflict] || 0) + 1;
    difficultyCounts[difficulty]++;
  }

  return { prompts, domainCounts, conflictCounts, difficultyCounts };
}

// ============================================================================
// MAIN
// ============================================================================

function main() {
  console.log('=== Liara Prompt Generator ===\n');

  const { prompts, domainCounts, conflictCounts, difficultyCounts } = generatePrompts(2000);

  writeFileSync(OUTPUT, JSON.stringify(prompts, null, 2), 'utf8');

  console.log(`Generated: ${prompts.length} prompts`);
  console.log(`Output: ${OUTPUT}`);
  console.log(`Size: ${(Buffer.byteLength(JSON.stringify(prompts)) / 1024 / 1024).toFixed(1)} MB\n`);

  console.log('--- Difficulty Distribution ---');
  for (const [d, c] of Object.entries(difficultyCounts)) {
    console.log(`  ${d}: ${c} (${((c / prompts.length) * 100).toFixed(1)}%)`);
  }

  console.log(`\n--- Conflict Type Distribution ---`);
  for (const [ct, c] of Object.entries(conflictCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${ct}: ${c} (${((c / prompts.length) * 100).toFixed(1)}%)`);
  }

  console.log(`\n--- Domain Distribution (${Object.keys(domainCounts).length} domains) ---`);
  for (const [d, c] of Object.entries(domainCounts).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${d}: ${c} (${((c / prompts.length) * 100).toFixed(1)}%)`);
  }
  console.log(`  ... and ${Object.keys(domainCounts).length - 10} more domains`);

  // Verify minimums
  const minPerDomain = Math.min(...Object.values(domainCounts));
  const maxPerDomain = Math.max(...Object.values(domainCounts));
  const valuesTradeoff = conflictCounts['values_tradeoff'] || 0;
  const ethicalDilemma = conflictCounts['ethical_dilemma'] || 0;

  console.log(`\n--- Validation ---`);
  console.log(`  Domains: ${Object.keys(domainCounts).length} (target: 50+) ${Object.keys(domainCounts).length >= 50 ? 'OK' : 'FAIL'}`);
  console.log(`  Min per domain: ${minPerDomain}`);
  console.log(`  Max per domain: ${maxPerDomain}`);
  console.log(`  values_tradeoff: ${valuesTradeoff} (target: 250+) ${valuesTradeoff >= 250 ? 'OK' : 'WARN'}`);
  console.log(`  ethical_dilemma: ${ethicalDilemma} (target: 250+) ${ethicalDilemma >= 250 ? 'OK' : 'WARN'}`);

  // Check unique prompts
  const uniqueTexts = new Set(prompts.map(p => p.prompt));
  console.log(`  Unique prompts: ${uniqueTexts.size}/${prompts.length}`);

  console.log('\n=== Done ===');
}

main();
