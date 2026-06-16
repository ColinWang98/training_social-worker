export const SOURCES = [
  {
    source: 'annomi',
    dataset: 'to-be/annomi-motivational-interviewing-therapy-conversations',
    preferredSplit: 'train',
    licenseNote: 'AnnoMI motivational interviewing conversations; local research/training use only, verify upstream license before redistribution.',
    runtimeEligible: true,
    qualityDefault: 'approved',
    clientSidePolicy: 'client_turns_only',
  },
  {
    source: 'student_mh_en',
    dataset: 'arafatanam/Student-Mental-Health-Counseling-EN',
    preferredSplit: 'train',
    licenseNote: 'Student mental-health counseling pairs; use student/client question side as service-user style pattern.',
    runtimeEligible: true,
    qualityDefault: 'approved',
    clientSidePolicy: 'question_as_client',
  },
  {
    source: 'amod',
    dataset: 'Amod/mental_health_counseling_conversations',
    preferredSplit: 'train',
    licenseNote: 'Mental-health counseling conversations; use client context/question side as service-user style pattern.',
    runtimeEligible: true,
    qualityDefault: 'approved',
    clientSidePolicy: 'question_as_client',
  },
  {
    source: 'therapytalk',
    dataset: 'MentalAgora/TherapyTalk',
    preferredSplit: 'test',
    licenseNote: 'Public help-seeking corpus; keep raw text local, remove identifying details from runtime export.',
    runtimeEligible: true,
    qualityDefault: 'review',
    clientSidePolicy: 'posts_as_client',
  },
  {
    source: 'addiction_sft',
    dataset: 'wesley7137/formatted_annotated_addiction_counseling_csv_SFT',
    preferredSplit: 'train',
    licenseNote: 'Addiction SFT corpus; mark normalized cards review before study use.',
    runtimeEligible: true,
    qualityDefault: 'review',
    clientSidePolicy: 'input_as_client',
  },
  {
    source: 'esconv',
    dataset: 'thu-coai/esconv',
    preferredSplit: 'train',
    licenseNote: 'ESConv emotional support dialogues; CC-BY-NC-4.0, local research/training use only.',
    runtimeEligible: true,
    qualityDefault: 'approved',
    clientSidePolicy: 'user_turns_only',
  },
  {
    source: 'counsel_chat',
    dataset: 'nbertagnolli/counsel-chat',
    preferredSplit: 'train',
    licenseNote: 'CounselChat forum scrape; keep raw text private, remove URLs/identifiers from runtime export, review before study use.',
    runtimeEligible: true,
    qualityDefault: 'review',
    clientSidePolicy: 'question_as_client',
  },
  {
    source: 'multilingual_therapy',
    dataset: 'Algorithmic-Human-Development-Group/Multilingual-Therapy-Dialogues',
    preferredSplit: 'train',
    licenseNote: 'Multilingual Therapy Dialogues; MIT, use patient side as style pattern only.',
    runtimeEligible: true,
    qualityDefault: 'approved',
    clientSidePolicy: 'patient_side_only',
  },
  {
    source: 'empathetic_dialogues',
    dataset: 'Estwld/empathetic_dialogues_llm',
    preferredSplit: 'train',
    licenseNote: 'Empathetic Dialogues LLM reformatted corpus; use user-side emotional reaction patterns only.',
    runtimeEligible: true,
    qualityDefault: 'approved',
    clientSidePolicy: 'user_turns_only',
  },
];

export const PRIVATE_CANDIDATE_SOURCES = [
  {
    source: 'reddit_mental_health_private',
    dataset: 'solomonk/reddit_mental_health_posts',
    preferredSplit: 'train',
    licenseNote: 'Large Reddit mental-health posts; private/review candidate only, not exported to runtime by default.',
    runtimeEligible: false,
    qualityDefault: 'review',
    clientSidePolicy: 'private_post_as_client',
  },
];

export function selectCorpusSources(mode = 'runtime') {
  if (mode === 'all') return [...SOURCES, ...PRIVATE_CANDIDATE_SOURCES];
  if (mode === 'private') return [...PRIVATE_CANDIDATE_SOURCES];
  return SOURCES.filter((source) => source.runtimeEligible !== false);
}

export function sourceByName(name) {
  return [...SOURCES, ...PRIVATE_CANDIDATE_SOURCES].find((source) => source.source === name);
}

export async function fetchDatasetSize(source) {
  const url = new URL('https://datasets-server.huggingface.co/size');
  url.searchParams.set('dataset', source.dataset);
  const response = await fetchWithRetry(url, 6, 'size');
  const data = await response.json();
  const resolved = await resolveSourceSplit(source);
  const splitSize = (data.size?.splits ?? []).find(
    (split) => split.config === resolved.config && split.split === resolved.split,
  );
  const configSize = (data.size?.configs ?? []).find((config) => config.config === resolved.config);
  const datasetSize = data.size?.dataset ?? {};
  return {
    source: source.source,
    dataset: source.dataset,
    config: resolved.config,
    split: resolved.split,
    expectedRows: splitSize?.num_rows ?? configSize?.num_rows ?? datasetSize.num_rows ?? null,
    parquetBytes: splitSize?.num_bytes_parquet_files ?? configSize?.num_bytes_parquet_files ?? datasetSize.num_bytes_parquet_files ?? null,
    memoryBytes: splitSize?.num_bytes_memory ?? configSize?.num_bytes_memory ?? datasetSize.num_bytes_memory ?? null,
    runtimeEligible: source.runtimeEligible !== false,
  };
}

export const CASE_COVERAGE = [
  {
    caseType: 'alcohol_misuse',
    sources: ['annomi', 'amod', 'multilingual_therapy', 'counsel_chat'],
    groups: ['adult', 'depression'],
    tags: ['alcohol', 'ambivalence', 'stress', 'depression', 'sleep'],
  },
  {
    caseType: 'student_depression_bullying',
    sources: ['student_mh_en', 'amod', 'esconv', 'empathetic_dialogues'],
    groups: ['student', 'depression'],
    tags: ['school', 'bullying', 'peer conflict', 'depression', 'sleep', 'self-harm'],
  },
  {
    caseType: 'anxiety_family_invalidated',
    sources: ['therapytalk', 'amod', 'student_mh_en', 'esconv', 'multilingual_therapy'],
    groups: ['anxiety', 'student'],
    tags: ['anxiety', 'panic', 'family invalidation', 'therapy access', 'family'],
  },
  {
    caseType: 'substance_recovery_meth',
    sources: ['addiction_sft', 'annomi', 'multilingual_therapy', 'counsel_chat'],
    groups: ['substance_use', 'adult'],
    tags: ['meth', 'withdrawal', 'relapse', 'shame', 'support plan', 'substance_use'],
  },
  {
    caseType: 'trauma_sleep_low_self_worth',
    sources: ['amod', 'therapytalk', 'counsel_chat', 'multilingual_therapy'],
    groups: ['trauma', 'depression', 'adult'],
    tags: ['trauma', 'sleep', 'self-worth', 'somatic', 'support'],
  },
];

export async function resolveSourceSplit(source) {
  const url = new URL('https://datasets-server.huggingface.co/splits');
  url.searchParams.set('dataset', source.dataset);
  const response = await fetchWithRetry(url, 6, 'splits');
  const data = await response.json();
  const splits = data.splits ?? [];
  if (!splits.length) {
    throw new Error(`${source.dataset} has no Dataset Viewer splits`);
  }

  const preferred =
    splits.find((split) => split.split === source.preferredSplit && split.config === 'default') ??
    splits.find((split) => split.split === source.preferredSplit) ??
    splits.find((split) => split.split === 'train') ??
    splits[0];

  return {
    config: preferred.config,
    split: preferred.split,
  };
}

export async function fetchRows({
  dataset,
  config,
  split,
  limit,
  pageDelayMs = 0,
  maxRetries = 6,
  requestTimeoutMs = 45_000,
  onProgress,
}) {
  const rows = [];
  let offset = 0;
  const boundedLimit = Number.isFinite(limit) ? limit : Infinity;
  let totalRows;

  while (rows.length < boundedLimit) {
    const length = Math.min(100, boundedLimit - rows.length);
    if (length <= 0) break;

    const url = new URL('https://datasets-server.huggingface.co/rows');
    url.searchParams.set('dataset', dataset);
    url.searchParams.set('config', config);
    url.searchParams.set('split', split);
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('length', String(length));

    const response = await fetchWithRetry(url, maxRetries, 'rows', requestTimeoutMs);
    const data = await response.json();
    const batch = data.rows ?? [];
    rows.push(...batch);
    offset += batch.length;
    if (typeof data.num_rows_total === 'number') totalRows = data.num_rows_total;
    if (typeof onProgress === 'function') {
      onProgress({
        dataset,
        config,
        split,
        rows: rows.length,
        totalRows,
        offset,
      });
    }

    if (!batch.length || batch.length < length) break;
    if (typeof data.num_rows_total === 'number' && offset >= data.num_rows_total) break;
    if (pageDelayMs > 0) await sleep(pageDelayMs);
  }

  return rows;
}

async function fetchWithRetry(url, maxRetries, endpoint = 'rows', requestTimeoutMs = 45_000) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
    } catch (error) {
      if (attempt === maxRetries) {
        throw new Error(`${url.searchParams.get('dataset')} ${endpoint} request failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      await sleep(Math.min(30_000, 1000 * 2 ** attempt));
      continue;
    }
    if (response.ok) return response;

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === maxRetries) {
      throw new Error(`${url.searchParams.get('dataset')} ${endpoint} request failed with ${response.status}`);
    }

    const retryAfter = Number(response.headers.get('retry-after'));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(30_000, 1000 * 2 ** attempt);
    await sleep(delay);
  }

  throw new Error(`${url.searchParams.get('dataset')} ${endpoint} request failed after retries`);
}

export function normalizeRow(source, row, rowKey = 'row') {
  if (source === 'annomi') return normalizeAnnoMi(row, rowKey);
  if (source === 'student_mh_en') return normalizeQuestionAnswer(source, row.Question, row.Answer);
  if (source === 'amod') return normalizeQuestionAnswer(source, row.Context, row.Response);
  if (source === 'therapytalk') return normalizeTherapyTalk(row);
  if (source === 'addiction_sft') return normalizeAddictionSft(row);
  if (source === 'esconv') return normalizeEsconv(row, rowKey);
  if (source === 'counsel_chat') return normalizeCounselChat(row);
  if (source === 'multilingual_therapy') return normalizeMultilingualTherapy(row, rowKey);
  if (source === 'empathetic_dialogues') return normalizeEmpatheticDialogues(row, rowKey);
  if (source === 'reddit_mental_health_private') return normalizeRedditMentalHealth(row);
  return [];
}

export function curateRuntimeCards(cards) {
  const seen = new Set();
  return cards
    .map((card) => {
      const flags = curationFlags(card, seen);
      return {
        ...card,
        quality: flags.some((flag) => flag.flag === 'duplicate' || flag.flag === 'too_short' || flag.flag === 'too_long')
          ? 'reject'
          : card.quality,
      };
    })
    .filter((card) => card.quality !== 'reject');
}

export function curationFlags(card, seenKeys) {
  const flags = [];
  const text = card.clientUtterance ?? '';
  const key = text.toLowerCase().replace(/\s+/g, ' ').slice(0, 180);

  if (seenKeys) {
    if (seenKeys.has(key)) {
      flags.push({ flag: 'duplicate', reason: 'Same normalized leading text already imported.' });
    } else {
      seenKeys.add(key);
    }
  }
  if (text.length < 24) flags.push({ flag: 'too_short', reason: 'Client utterance is shorter than 24 characters.' });
  if (text.length > 900) flags.push({ flag: 'too_long', reason: 'Client utterance is longer than 900 characters.' });
  if (/https?:\/\/|www\./i.test(text)) flags.push({ flag: 'url', reason: 'Client utterance contains a URL.' });
  if (/@[a-z0-9_]{3,}/i.test(text)) flags.push({ flag: 'pii', reason: 'Client utterance contains a handle-like token.' });
  if (/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/.test(text)) {
    flags.push({ flag: 'date', reason: 'Client utterance contains a date-like token.' });
  }
  if (card.quality === 'review') flags.push({ flag: 'needs_review', reason: 'Source or content requires review before study use.' });
  if (card.quality === 'reject') flags.push({ flag: 'reject', reason: 'Rule classifier rejected the card.' });

  return flags;
}

export function sanitizeRuntimeText(value) {
  return cleanText(value)
    .replace(/https?:\/\/\S+|www\.\S+/gi, '[link removed]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email removed]')
    .replace(/@[a-z0-9_]{3,}/gi, '[handle removed]')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '[date removed]')
    .replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, '[date removed]')
    .replace(/&amp;#x200B;|&#x200B;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function hashText(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16);
}

function normalizeAnnoMi(row, rowKey) {
  const turns = Array.isArray(row.conversations) ? row.conversations : [];
  const cards = [];
  let previousWorkerMove;

  turns.forEach((turn, index) => {
    const text = cleanText(turn.value);
    if (!text) return;
    if (turn.from === 'gpt') {
      previousWorkerMove = text;
      return;
    }
    const classified = classifyText(text, 'annomi');
    cards.push({
      id: `annomi-${row.id ?? rowKey}-${index}`,
      source: 'annomi',
      clientGroup: classified.clientGroup,
      issueTags: classified.issueTags,
      clientUtterance: text,
      workerMove: previousWorkerMove,
      affect: classified.affect,
      riskSignals: classified.riskSignals,
      resistanceType: classified.resistanceType,
      changeTalk: classified.changeTalk,
      disclosureDepth: classified.disclosureDepth,
      quality: classified.quality,
      licenseNote: 'Imported from Hugging Face row; verify dataset license and keep provenance before redistribution.',
      provenanceNote: 'HF Dataset Viewer row normalized locally.',
    });
  });

  return cards;
}

function normalizeQuestionAnswer(source, question, answer) {
  const text = cleanText(question);
  if (!text) return [];
  const classified = classifyText(text, source);
  return [
    {
      id: `${source}-${hashText(text)}`,
      source,
      clientGroup: classified.clientGroup,
      issueTags: classified.issueTags,
      clientUtterance: text,
      workerMove: cleanText(answer),
      affect: classified.affect,
      riskSignals: classified.riskSignals,
      resistanceType: classified.resistanceType,
      changeTalk: classified.changeTalk,
      disclosureDepth: classified.disclosureDepth,
      quality: classified.quality,
      licenseNote: 'Imported from Hugging Face row; verify dataset license and keep provenance before redistribution.',
      provenanceNote: 'HF Dataset Viewer row normalized locally.',
    },
  ];
}

function normalizeTherapyTalk(row) {
  const posts = [row.post1, row.post2, row.post3].map(cleanText).filter(Boolean);
  const response = cleanText(row.response);
  return posts.map((post, index) => {
    const classified = classifyText(post, 'therapytalk');
    return {
      id: `therapytalk-${hashText(post)}-${index}`,
      source: 'therapytalk',
      clientGroup: classified.clientGroup,
      issueTags: classified.issueTags,
      clientUtterance: post,
      workerMove: response,
      affect: classified.affect,
      riskSignals: classified.riskSignals,
      resistanceType: classified.resistanceType,
      changeTalk: classified.changeTalk,
      disclosureDepth: classified.disclosureDepth,
      quality: classified.quality === 'approved' ? 'review' : classified.quality,
      licenseNote: 'Imported from public help-seeking corpus; remove identifying details and review before study use.',
      provenanceNote: 'TherapyTalk row normalized locally; raw author/date fields stay only in private SQLite raw_rows.',
    };
  });
}

function normalizeAddictionSft(row) {
  const text = cleanText(row.text ?? row.prompt ?? row.instruction);
  if (!text) return [];
  const input = text.match(/### Input:\s*([\s\S]*?)(?:### Response:|$)/i)?.[1] ?? text;
  const response = text.match(/### Response:\s*([\s\S]*)$/i)?.[1] ?? row.output ?? row.response;
  const clientText = cleanText(input);
  if (!clientText) return [];
  const classified = classifyText(clientText, 'addiction_sft');
  return [
    {
      id: `addiction-sft-${hashText(clientText)}`,
      source: 'addiction_sft',
      clientGroup: 'substance_use',
      issueTags: [...new Set([...classified.issueTags, 'substance_use'])],
      clientUtterance: clientText,
      workerMove: cleanText(response),
      affect: classified.affect,
      riskSignals: classified.riskSignals,
      resistanceType: classified.resistanceType,
      changeTalk: classified.changeTalk,
      disclosureDepth: classified.disclosureDepth,
      quality: 'review',
      licenseNote: 'Imported from addiction SFT corpus; treat as needs_review before study use.',
      provenanceNote: 'Addiction SFT row normalized locally; review before study use.',
    },
  ];
}

function normalizeEsconv(row, rowKey) {
  const parsed = parseMaybeJson(row.text);
  const turns = Array.isArray(parsed?.dialog) ? parsed.dialog : [];
  const cards = [];
  let previousWorkerMove = cleanText(parsed?.situation);
  turns.forEach((turn, index) => {
    const text = cleanText(turn.text);
    if (!text) return;
    if (turn.speaker === 'sys') {
      previousWorkerMove = text;
      return;
    }
    if (turn.speaker !== 'usr') return;
    const classified = classifyText([text, parsed?.situation, parsed?.emotion_type, parsed?.problem_type].filter(Boolean).join(' '), 'esconv');
    cards.push({
      id: `esconv-${rowKey}-${index}`,
      source: 'esconv',
      clientGroup: classified.clientGroup,
      issueTags: uniqueTags([...classified.issueTags, parsed?.emotion_type, parsed?.problem_type]),
      clientUtterance: text,
      workerMove: previousWorkerMove,
      affect: classified.affect,
      riskSignals: classified.riskSignals,
      resistanceType: classified.resistanceType,
      changeTalk: classified.changeTalk,
      disclosureDepth: classified.disclosureDepth,
      quality: classified.quality,
      licenseNote: 'ESConv emotional support dialogues; CC-BY-NC-4.0, local non-commercial research/training use only.',
      provenanceNote: 'HF Dataset Viewer row normalized locally; user-side turns only.',
    });
  });
  return cards;
}

function normalizeCounselChat(row) {
  const text = cleanText(row.questionText ?? row.questionTitle);
  if (!text) return [];
  const classified = classifyText([text, row.topic].filter(Boolean).join(' '), 'counsel_chat');
  return [
    {
      id: `counsel-chat-${row.questionID ?? hashText(text)}-${hashText(text)}`,
      source: 'counsel_chat',
      clientGroup: classified.clientGroup,
      issueTags: uniqueTags([...classified.issueTags, row.topic]),
      clientUtterance: text,
      workerMove: cleanText(row.answerText),
      affect: classified.affect,
      riskSignals: classified.riskSignals,
      resistanceType: classified.resistanceType,
      changeTalk: classified.changeTalk,
      disclosureDepth: classified.disclosureDepth,
      quality: classified.quality === 'reject' ? 'reject' : 'review',
      licenseNote: 'CounselChat forum scrape; keep raw text private, remove URLs and identifying details from runtime export.',
      provenanceNote: 'CounselChat question normalized locally; therapist metadata remains private raw row only.',
    },
  ];
}

function normalizeMultilingualTherapy(row, rowKey) {
  const text = cleanText(row.Patient);
  if (!text) return [];
  const classified = classifyText(text, 'multilingual_therapy');
  return [
    {
      id: `multilingual-therapy-${rowKey}-${hashText(text)}`,
      source: 'multilingual_therapy',
      clientGroup: classified.clientGroup,
      issueTags: classified.issueTags,
      clientUtterance: text,
      workerMove: cleanText(row.Therapist),
      affect: classified.affect,
      riskSignals: classified.riskSignals,
      resistanceType: classified.resistanceType,
      changeTalk: classified.changeTalk,
      disclosureDepth: classified.disclosureDepth,
      quality: classified.quality,
      licenseNote: 'Multilingual Therapy Dialogues; MIT, use patient-side turns as style patterns only.',
      provenanceNote: 'HF Dataset Viewer row normalized locally; Persian translations retained only in raw row.',
    },
  ];
}

function normalizeEmpatheticDialogues(row, rowKey) {
  const turns = Array.isArray(row.conversations) ? row.conversations : [];
  const cards = [];
  let previousWorkerMove = cleanText(row.situation);
  turns.forEach((turn, index) => {
    const text = cleanText(turn.content);
    if (!text) return;
    if (turn.role === 'assistant') {
      previousWorkerMove = text;
      return;
    }
    if (turn.role !== 'user') return;
    const classified = classifyText([text, row.situation, row.emotion].filter(Boolean).join(' '), 'empathetic_dialogues');
    cards.push({
      id: `empathetic-dialogues-${row.conv_id ?? rowKey}-${index}`,
      source: 'empathetic_dialogues',
      clientGroup: classified.clientGroup,
      issueTags: uniqueTags([...classified.issueTags, row.emotion]),
      clientUtterance: text,
      workerMove: previousWorkerMove,
      affect: classified.affect,
      riskSignals: classified.riskSignals,
      resistanceType: classified.resistanceType,
      changeTalk: classified.changeTalk,
      disclosureDepth: classified.disclosureDepth,
      quality: classified.quality,
      licenseNote: 'Empathetic Dialogues LLM reformatted corpus; use user-side emotional reaction patterns only.',
      provenanceNote: 'HF Dataset Viewer row normalized locally; user-side turns only.',
    });
  });
  return cards;
}

function normalizeRedditMentalHealth(row) {
  const text = cleanText(`${row.title ?? ''}\n${row.body ?? ''}`);
  if (!text) return [];
  const classified = classifyText(text, 'reddit_mental_health_private');
  return [
    {
      id: `reddit-mental-health-private-${row.id ?? hashText(text)}`,
      source: 'reddit_mental_health_private',
      clientGroup: classified.clientGroup,
      issueTags: uniqueTags([...classified.issueTags, row.subreddit]),
      clientUtterance: text,
      workerMove: undefined,
      affect: classified.affect,
      riskSignals: classified.riskSignals,
      resistanceType: classified.resistanceType,
      changeTalk: classified.changeTalk,
      disclosureDepth: classified.disclosureDepth,
      quality: 'review',
      licenseNote: 'Reddit mental-health posts; private/review candidate only, do not export raw text to runtime without ethics review.',
      provenanceNote: 'Private candidate normalized locally; author/url/date fields must remain private.',
    },
  ];
}

function classifyText(text, source) {
  const lower = text.toLowerCase();
  const issueTags = [];
  const riskSignals = [];
  const changeTalk = [];
  let clientGroup = source === 'student_mh_en' ? 'student' : 'adult';
  let affect = 'neutral';
  let resistanceType;
  let disclosureDepth = 1;
  let quality = 'approved';

  tag(lower, issueTags, 'alcohol', ['drink', 'drinking', 'alcohol', 'wine', 'beer']);
  tag(lower, issueTags, 'meth', ['meth', 'crystal', 'ice']);
  tag(lower, issueTags, 'substance_use', ['drug', 'use again', 'relapse', 'craving', 'withdrawal']);
  tag(lower, issueTags, 'depression', ['depress', 'hopeless', 'worthless', 'empty', 'low mood']);
  tag(lower, issueTags, 'anxiety', ['anxiety', 'anxious', 'panic', 'chest tight', 'worry']);
  tag(lower, issueTags, 'sleep', ['sleep', 'insomnia', 'awake']);
  tag(lower, issueTags, 'family', ['family', 'mother', 'father', 'parents', 'spouse', 'sister']);
  tag(lower, issueTags, 'school', ['school', 'class', 'teacher', 'exam', 'grade', 'homework']);
  tag(lower, issueTags, 'bullying', ['bully', 'tease', 'mock', 'group chat', 'excluded']);
  tag(lower, issueTags, 'trauma', ['trauma', 'abuse', 'assault', 'flashback']);

  tag(lower, riskSignals, 'passive self-harm language', ['not wake up', 'do not wake up', 'wish i was dead', 'suicide', 'kill myself']);
  tag(lower, riskSignals, 'withdrawal risk', ['withdrawal', 'detox']);
  tag(lower, riskSignals, 'relapse trigger', ['relapse', 'craving', 'use again']);
  tag(lower, riskSignals, 'sleep disruption', ['insomnia', 'cannot sleep', "can't sleep"]);
  tag(lower, riskSignals, 'trauma overwhelm', ['flashback', 'too much to talk about']);

  if (/(want to|need to|could|maybe i can|try|willing|ready)/i.test(text)) {
    changeTalk.push('desire or ability');
    disclosureDepth = Math.max(disclosureDepth, 3);
  }
  if (/(not a problem|not that bad|fine|overreacting)/i.test(text)) resistanceType = 'minimizing';
  if (/(ashamed|embarrassed|stupid|my fault)/i.test(text)) resistanceType = 'shame';
  if (/(do not want to talk|don't want to talk|avoid|rather not)/i.test(text)) resistanceType = 'avoidance';
  if (/(angry|mad|annoyed)/i.test(text)) resistanceType = 'anger';
  if (/(but|part of me|on the other hand)/i.test(text)) resistanceType = resistanceType ?? 'ambivalence';

  if (issueTags.includes('substance_use') || issueTags.includes('meth')) clientGroup = 'substance_use';
  if (issueTags.includes('depression')) clientGroup = clientGroup === 'student' ? 'student' : 'depression';
  if (issueTags.includes('anxiety')) clientGroup = clientGroup === 'student' ? 'student' : 'anxiety';
  if (issueTags.includes('trauma')) clientGroup = 'trauma';

  if (resistanceType === 'shame') affect = 'ashamed';
  else if (resistanceType === 'avoidance') affect = 'withdrawn';
  else if (resistanceType === 'minimizing') affect = 'defensive';
  else if (issueTags.includes('anxiety')) affect = 'anxious';
  else if (issueTags.includes('depression')) affect = 'sad';
  else if (changeTalk.length) affect = 'reflective';

  if (riskSignals.length) disclosureDepth = 4;
  else if (issueTags.length >= 3) disclosureDepth = Math.max(disclosureDepth, 2);

  if (text.length < 24 || text.length > 900) quality = 'reject';
  if (source === 'therapytalk' || source === 'addiction_sft') quality = quality === 'reject' ? 'reject' : 'review';

  return {
    clientGroup,
    issueTags: issueTags.length ? issueTags : ['general_distress'],
    affect,
    riskSignals,
    resistanceType,
    changeTalk,
    disclosureDepth,
    quality,
  };
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value && typeof value === 'object' ? value : null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function uniqueTags(values) {
  return [...new Set(values.map((value) => cleanText(value).toLowerCase()).filter(Boolean))];
}

function tag(text, output, label, needles) {
  if (needles.some((needle) => text.includes(needle))) output.push(label);
}

function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
