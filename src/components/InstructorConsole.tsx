import { ComponentProps, useState } from 'react';
import { ArrowLeft, Database, Mic2, Network, Settings2, UserRoundCog } from 'lucide-react';
import { avatarAssets } from '../lib/avatarConfig';
import { ResponseLanguage } from '../lib/interviewTypes';
import { CasePanel, InstructorTab } from './CasePanel';
import { AvatarExpressionLab } from './AvatarExpressionLab';

type InstructorConsoleProps = Omit<ComponentProps<typeof CasePanel>, 'viewMode' | 'instructorTab'> & {
  avatarAssetId: string;
  onAvatarAssetChange: (avatarId: string) => void;
  onBackToTraining: () => void;
  onOpenEvidence: () => void;
  username: string;
};

const tabs: Array<{ id: InstructorTab; zh: string; en: string; icon: typeof Network }> = [
  { id: 'session', zh: 'Session 連續性', en: 'Session', icon: Network },
  { id: 'case', zh: '個案與 PIE', en: 'Case & PIE', icon: UserRoundCog },
  { id: 'retrieval', zh: '檢索與評估', en: 'Retrieval & Evaluation', icon: Database },
  { id: 'avatar', zh: 'Avatar 與語音', en: 'Avatar & Voice', icon: Mic2 },
];

export function InstructorConsole({
  avatarAssetId,
  onAvatarAssetChange,
  onBackToTraining,
  onOpenEvidence,
  username,
  uiLanguage,
  ...casePanelProps
}: InstructorConsoleProps) {
  const [activeTab, setActiveTab] = useState<InstructorTab>('session');
  const english = uiLanguage === 'english';

  return (
    <main className="instructorConsole">
      <header className="instructorHeader">
        <div className="instructorBrand">
          <button className="iconButton" type="button" onClick={onBackToTraining} aria-label={english ? 'Back to training' : '返回訓練'}>
            <ArrowLeft size={17} />
          </button>
          <div>
            <span>{english ? 'Protected instructor workspace' : '受保護的督導工作台'}</span>
            <h1>{english ? 'Instructor Console' : '督導 / 研究者控制台'}</h1>
          </div>
        </div>
        <div className="instructorHeaderActions">
          <label>
            <span>Avatar</span>
            <select value={avatarAssetId} onChange={(event) => onAvatarAssetChange(event.target.value)}>
              {avatarAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.displayName}</option>)}
            </select>
          </label>
          <button className="secondaryActionButton" type="button" onClick={onOpenEvidence}>
            <Database size={16} /> Evidence Cards
          </button>
          <div className="accountBadge"><Settings2 size={15} /><span>{username}</span><strong>Instructor</strong></div>
        </div>
      </header>

      <nav className="instructorTabs" aria-label={english ? 'Instructor sections' : '督導工作區欄目'}>
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button className={activeTab === tab.id ? 'active' : ''} key={tab.id} type="button" onClick={() => setActiveTab(tab.id)}>
              <Icon size={16} />
              {english ? tab.en : tab.zh}
            </button>
          );
        })}
      </nav>

      <section className="instructorContent">
        {activeTab === 'avatar' && <AvatarExpressionLab asset={avatarAssets.find((asset) => asset.id === avatarAssetId) ?? avatarAssets[0]} language={uiLanguage} />}
        <CasePanel
          {...casePanelProps}
          uiLanguage={uiLanguage as ResponseLanguage}
          viewMode="instructor"
          instructorTab={activeTab}
        />
      </section>
    </main>
  );
}
