import { CaseProfile, CaseType, MotionCue, ResponseLanguage } from './interviewTypes';
import { motionCuePrompts } from './avatarConfig';

type UiKey =
  | 'appTitle'
  | 'appSubtitle'
  | 'avatarLabel'
  | 'voiceLabel'
  | 'evidenceCards'
  | 'stopService'
  | 'stopping'
  | 'model'
  | 'credit'
  | 'defaultCantoneseVoice'
  | 'interviewWorkspace'
  | 'interviewDescription'
  | 'sessionEndedNotice'
  | 'riskSignal'
  | 'emptyTitle'
  | 'emptyBody'
  | 'studentWorker'
  | 'serviceUser'
  | 'revealed'
  | 'voiceModeAria'
  | 'stopUtterance'
  | 'closeVoice'
  | 'voiceMode'
  | 'studentMessage'
  | 'sessionEndedPlaceholder'
  | 'messagePlaceholder'
  | 'ended'
  | 'generating'
  | 'send'
  | 'panelAria'
  | 'displayMode'
  | 'traineeMode'
  | 'instructorMode'
  | 'traineeModeHint'
  | 'instructorModeHint'
  | 'caseState'
  | 'issueType'
  | 'observableState'
  | 'observableNoFacts'
  | 'observableWithFacts'
  | 'supervision'
  | 'supervisionDuring'
  | 'generatingReport'
  | 'viewReport'
  | 'endSession'
  | 'reportReady'
  | 'endSessionHint'
  | 'revealedInfo'
  | 'knownUnknownCount'
  | 'noRevealedFacts'
  | 'fullReport'
  | 'fullReportSubtitle'
  | 'closeReport'
  | 'overallPerformance'
  | 'effectiveMoments'
  | 'missedOpportunities'
  | 'caseFramework'
  | 'objectivesMet'
  | 'objectivesNotMet'
  | 'practiceGoals'
  | 'hkPcf'
  | 'hkPcfRadar'
  | 'strengthEvidence'
  | 'concernEvidence'
  | 'turningPoints'
  | 'practiceRecommendations'
  | 'pieAssessment'
  | 'frameworkBasis'
  | 'instructorNote'
  | 'instructorNoteBody'
  | 'turningPointReview'
  | 'alternativeMove';

export const uiText: Record<ResponseLanguage, Record<UiKey, string>> = {
  cantonese: {
    appTitle: '社工訪談 Avatar 訓練',
    appSubtitle: '本地訪談訓練原型：VRM 服務對象、個案狀態、DeepSeek 對話、檢索式證據卡及督導回饋。',
    avatarLabel: 'Avatar',
    voiceLabel: '回覆語言',
    evidenceCards: 'Evidence Cards',
    stopService: '停止服務',
    stopping: '正在停止',
    model: '模型',
    credit: '署名',
    defaultCantoneseVoice: '環境預設粵語聲線',
    interviewWorkspace: '訪談練習',
    interviewDescription: '練習建立關係、探索脈絡、風險篩查及安全下一步。',
    sessionEndedNotice: '訪談已結束，完整督導報告已移至右側面板。',
    riskSignal: '風險訊號',
    emptyTitle: '用平穩的開場開始。',
    emptyBody: '可以先問最近發生了甚麼、他想大人明白甚麼，或由一件具體近況慢慢談起。',
    studentWorker: '學生社工',
    serviceUser: '服務對象',
    revealed: '已透露',
    voiceModeAria: '語音模式',
    stopUtterance: '提交這句',
    closeVoice: '關閉語音',
    voiceMode: '開啟語音',
    studentMessage: '學生社工訊息',
    sessionEndedPlaceholder: '訪談已結束。',
    messagePlaceholder: '輸入下一句社工訪談提問...',
    ended: '已結束',
    generating: '生成中',
    send: '送出',
    panelAria: '個案狀態及督導',
    displayMode: '顯示模式',
    traineeMode: '學生社工',
    instructorMode: '督導/研究者',
    traineeModeHint: '訓練視圖只顯示轉介摘要和訪談中自然出現的資訊。',
    instructorModeHint: '完整個案、證據與調試資訊只供督導、研究者或本地測試使用。',
    caseState: '個案狀態',
    issueType: '問題類型',
    observableState: '可觀察狀態',
    observableNoFacts: '目前只能根據轉介摘要和對話反應探索。',
    observableWithFacts: '已開始透露部分背景，但仍需要以開放式和同理方式跟進。',
    supervision: '督導評估',
    supervisionDuring: '訪談進行中不顯示完整督導回饋；系統只在背景記錄過程，完整評估會於結束訪談後生成。',
    generatingReport: '正在生成督導報告',
    viewReport: '查看完整督導報告',
    endSession: '結束訪談並生成報告',
    reportReady: '督導報告已生成',
    endSessionHint: '完成練習後按「結束訪談」，系統會基於整場 transcript、風險探索、透露節奏和關係變化生成報告。',
    revealedInfo: '已透露資訊',
    knownUnknownCount: '已知 {{known}} / 未透露 {{unknown}}',
    noRevealedFacts: '暫時未在訪談中透露具體背景。',
    fullReport: '完整督導報告',
    fullReportSubtitle: '訪談後評估，以香港社工實務能力參考框架整理。',
    closeReport: '關閉督導報告',
    overallPerformance: '總體表現',
    effectiveMoments: '有效做法',
    missedOpportunities: '錯過機會',
    caseFramework: '個案特定框架',
    objectivesMet: '已達成學習目標',
    objectivesNotMet: '仍需練習目標',
    practiceGoals: '下一次練習建議',
    hkPcf: '香港社工實務能力參考',
    hkPcfRadar: 'HK PCF 能力雷達圖',
    strengthEvidence: '能力證據：有效表現',
    concernEvidence: '能力證據：需留意',
    turningPoints: '關鍵片段',
    practiceRecommendations: '具體練習建議',
    pieAssessment: '人在情境評估',
    frameworkBasis: '框架依據',
    instructorNote: '督導/研究者提示',
    instructorNoteBody: '此區只顯示評估框架與 trace evidence 摘要；正式訓練視圖不提前展示未透露個案資料。',
    turningPointReview: '關鍵片段回顧',
    alternativeMove: '可替代做法',
  },
  english: {
    appTitle: 'Social Work Avatar Training',
    appSubtitle: 'Local interview training prototype with a VRM client, case state, DeepSeek dialogue, retrieval evidence cards, and post-session supervision.',
    avatarLabel: 'Avatar',
    voiceLabel: 'Response language',
    evidenceCards: 'Evidence Cards',
    stopService: 'Stop Services',
    stopping: 'Stopping',
    model: 'Model',
    credit: 'Credit',
    defaultCantoneseVoice: 'Default Cantonese voice',
    interviewWorkspace: 'Interview Practice',
    interviewDescription: 'Practice engagement, context exploration, risk screening, and safe next steps.',
    sessionEndedNotice: 'The interview has ended. The full supervision report is in the right panel.',
    riskSignal: 'Risk cue',
    emptyTitle: 'Start with a steady opening.',
    emptyBody: 'You can ask what has been happening recently, what they wish adults understood, or begin with one concrete recent situation.',
    studentWorker: 'Student social worker',
    serviceUser: 'Client',
    revealed: 'Revealed',
    voiceModeAria: 'Voice mode',
    stopUtterance: 'Submit this turn',
    closeVoice: 'Close voice',
    voiceMode: 'Start voice',
    studentMessage: 'Student social worker message',
    sessionEndedPlaceholder: 'The interview has ended.',
    messagePlaceholder: 'Enter the next social-work interview question...',
    ended: 'Ended',
    generating: 'Generating',
    send: 'Send',
    panelAria: 'Case state and supervision',
    displayMode: 'View Mode',
    traineeMode: 'Trainee',
    instructorMode: 'Instructor',
    traineeModeHint: 'Trainee view only shows the referral summary and information naturally disclosed in the interview.',
    instructorModeHint: 'Full case, evidence, and debug information is for instructors, researchers, or local testing only.',
    caseState: 'Case State',
    issueType: 'Issue Type',
    observableState: 'Observable state',
    observableNoFacts: 'For now, explore from the referral summary and the client’s observable responses.',
    observableWithFacts: 'Some background has started to emerge; continue with open questions and empathic follow-up.',
    supervision: 'Supervision',
    supervisionDuring: 'Detailed supervision is hidden during the interview. The system records the process in the background and generates a full report after the session.',
    generatingReport: 'Generating report',
    viewReport: 'View full report',
    endSession: 'End interview and generate report',
    reportReady: 'Supervision report ready',
    endSessionHint: 'After practice, end the interview to generate a report based on the full transcript, risk exploration, disclosure pacing, and relationship changes.',
    revealedInfo: 'Revealed Information',
    knownUnknownCount: 'Known {{known}} / undisclosed {{unknown}}',
    noRevealedFacts: 'No concrete background has been disclosed yet.',
    fullReport: 'Full Supervision Report',
    fullReportSubtitle: 'Post-session evaluation organized through a Hong Kong social-work practice competency reference.',
    closeReport: 'Close supervision report',
    overallPerformance: 'Overall Performance',
    effectiveMoments: 'Effective Moments',
    missedOpportunities: 'Missed Opportunities',
    caseFramework: 'Case-Specific Frameworks',
    objectivesMet: 'Learning Objectives Met',
    objectivesNotMet: 'Learning Objectives Still Needed',
    practiceGoals: 'Next Practice Goals',
    hkPcf: 'Hong Kong Social Work Practice Competency Reference',
    hkPcfRadar: 'HK PCF Competency Radar',
    strengthEvidence: 'Competency Evidence: Strengths',
    concernEvidence: 'Competency Evidence: Concerns',
    turningPoints: 'Turning Points',
    practiceRecommendations: 'Practice Recommendations',
    pieAssessment: 'Person-in-Environment Assessment',
    frameworkBasis: 'Framework Basis',
    instructorNote: 'Instructor / Researcher Note',
    instructorNoteBody: 'This section only shows framework and trace-evidence summaries; formal trainee view does not reveal undisclosed case material during training.',
    turningPointReview: 'Turning Point Review',
    alternativeMove: 'Alternative move',
  },
};

export function t(language: ResponseLanguage, key: UiKey, values?: Record<string, string | number>) {
  let text = uiText[language][key];
  if (!values) return text;
  Object.entries(values).forEach(([name, value]) => {
    text = text.replace(`{{${name}}}`, String(value));
  });
  return text;
}

const caseDisplayText: Record<CaseType, Record<ResponseLanguage, { issueLabel: string; title: string; context: string }>> = {
  student_depression_bullying: {
    cantonese: {
      issueLabel: '學生抑鬱與欺凌',
      title: '中學生被排擠、學業壓力與低落',
      context: '學校社工第一次約見。老師留意到他近期退縮、欠交功課，午膳時間亦經常避開同學。',
    },
    english: {
      issueLabel: 'Student depression and bullying',
      title: 'Secondary student facing exclusion, academic pressure, and low mood',
      context: 'First meeting with a school social worker. The teacher has noticed withdrawal, missing homework, and avoiding peers during lunch.',
    },
  },
  alcohol_misuse: {
    cantonese: {
      issueLabel: '酗酒／酒精濫用',
      title: '成人酒精使用與情緒低落',
      context: '基層醫療社工跟進篩查結果，當中顯示她飲酒頻密並有睡眠問題。',
    },
    english: {
      issueLabel: 'Alcohol misuse',
      title: 'Adult alcohol use and low mood',
      context: 'A primary-care social worker is following up on screening results showing frequent drinking and sleep difficulties.',
    },
  },
  anxiety_family_invalidated: {
    cantonese: {
      issueLabel: '焦慮與家庭否定',
      title: '年輕成人焦慮、驚恐與求助阻力',
      context: '一名年輕成人因焦慮和驚恐症狀求助，但家人一直淡化問題並反對她接受輔導。',
    },
    english: {
      issueLabel: 'Anxiety and family invalidation',
      title: 'Young adult anxiety, panic symptoms, and help-seeking barriers',
      context: 'A young adult seeks help for anxiety and panic symptoms, while family members minimize the issue and discourage counseling.',
    },
  },
  substance_recovery_meth: {
    cantonese: {
      issueLabel: '藥物濫用復元',
      title: '冰毒使用、戒斷恐懼與復發風險',
      context: '社區社工接觸一名想停止使用冰毒、但害怕戒斷和復發的服務使用者。',
    },
    english: {
      issueLabel: 'Substance-use recovery',
      title: 'Meth use, withdrawal fear, and relapse risk',
      context: 'A community social worker meets a client who wants to stop using meth but fears withdrawal and relapse.',
    },
  },
  trauma_sleep_low_self_worth: {
    cantonese: {
      issueLabel: '創傷／失眠／低自我價值',
      title: '長期創傷、睡眠困擾與低自我價值',
      context: '社工接觸一名長期失眠、低自我價值，並有從未在服務中談及的創傷經歷的服務使用者。',
    },
    english: {
      issueLabel: 'Trauma, insomnia, and low self-worth',
      title: 'Long-term trauma, sleep disturbance, and low self-worth',
      context: 'A social worker meets a client with chronic insomnia, low self-worth, and trauma experiences not previously discussed in services.',
    },
  },
};

export function caseDisplay(profile: CaseProfile, language: ResponseLanguage) {
  return caseDisplayText[profile.caseType]?.[language] ?? {
    issueLabel: profile.issueLabel,
    title: profile.localizedTitle,
    context: profile.client.presentingContext,
  };
}

export function observableLabel(language: ResponseLanguage, affect: string) {
  if (language === 'english') {
    if (affect.includes('defensive')) return 'Defensive, keeping distance';
    if (affect.includes('withdrawn')) return 'Withdrawn, saying little';
    if (affect.includes('anxious')) return 'Anxious and unsettled';
    if (affect.includes('ashamed')) return 'Ashamed, gaze lowered';
    if (affect.includes('irritated')) return 'Irritated and resistant';
    if (affect.includes('sad')) return 'Low and depleted';
    if (affect.includes('reflective')) return 'Somewhat reflective';
    return 'Watchful, not fully engaged';
  }
  if (affect.includes('defensive')) return '防衛、保持距離';
  if (affect.includes('withdrawn')) return '退縮、少說話';
  if (affect.includes('anxious')) return '緊張、不安';
  if (affect.includes('ashamed')) return '羞恥、低頭迴避';
  if (affect.includes('irritated')) return '被冒犯、抗拒';
  if (affect.includes('sad')) return '低落、無力';
  if (affect.includes('reflective')) return '稍為願意思考';
  return '觀望、未完全投入';
}

export function motionPrompt(language: ResponseLanguage, cue: MotionCue) {
  if (language === 'cantonese') return motionCuePrompts[cue];
  const prompts: Record<MotionCue, string> = {
    neutral: 'Neutral seated posture',
    look_down: 'Looks down with reduced eye contact',
    avoid_eye_contact: 'Avoids direct eye contact',
    rub_hands: 'Small anxious hand movement',
    lean_back: 'Leans back guardedly',
    slow_nod: 'Slow reflective nod',
  };
  return prompts[cue];
}
