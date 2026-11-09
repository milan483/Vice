import {useId, useState} from 'react';

import {t} from '../lib/i18n';
import {DEFAULT_MANUAL, exactAccent, type ExactColors} from '../theme/exactAccent';
import {SchemePreview} from './AccentPicker';
import {Modal} from './Modal';

export function ExactAccentPicker({initial, onCancel, onConfirm}: {
  initial: ExactColors | null;
  onCancel: () => void;
  onConfirm: (colors: ExactColors) => void;
}) {
  const [colors, setColors] = useState(initial ?? DEFAULT_MANUAL);
  const {ramp, error} = exactAccent(colors);
  const errorId = useId();

  return (
    <Modal open title={t('accents.manualTitle')} onClose={onCancel} footer={
      <>
        <button type="button" className="btn btn-quiet" onClick={() => setColors(DEFAULT_MANUAL)}>
          {t('accents.resetExact')}
        </button>
        <button type="button" className="btn btn-quiet" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button type="button" className="btn" disabled={!ramp} onClick={() => {
          if (ramp) onConfirm({base: ramp.base, bg: ramp.bg});
        }}>
          {t('accents.applyExact')}
        </button>
      </>
    }>
      <p className="ap-lede">{t('accents.manualBody')}</p>
      <div className="ap-exact-fields">
        {(['base', 'bg'] as const).map(role => (
          <label key={role}>
            {t(role === 'base' ? 'accents.exactPrimary' : 'accents.exactBackground')}
            <input
              className="ap-hex mono"
              value={colors[role]}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              onKeyDown={event => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  onCancel();
                }
              }}
              onChange={event => setColors({...colors, [role]: event.target.value})}
            />
          </label>
        ))}
      </div>
      <div id={errorId} role="status">
        {error ? <p className="ap-warning">{t(`accents.${error}`)}</p> : null}
      </div>
      {ramp ? <SchemePreview ramp={ramp} /> : null}
    </Modal>
  );
}
