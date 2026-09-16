import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Modal, Space, Spin, Typography } from 'antd';
import { api, RootEmailJobView, RootManualCaptchaView } from '../api';

/** Keep the live image and answer only in component memory, and discard them when closed. */
export default function RootManualCaptchaModal({ job, onClose, onProgress }: {
  job: RootEmailJobView | null; onClose: () => void; onProgress: () => void;
}) {
  const [challenge, setChallenge] = useState<RootManualCaptchaView | null>(null);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const challengeId = useRef('');
  const inFlight = useRef(false);
  const jobId = job?.id;
  useEffect(() => {
    setChallenge(null); setAnswer(''); setError(''); challengeId.current = '';
  }, [jobId]);
  useEffect(() => {
    if (!jobId || !job?.manualCaptchaAvailable) { setChallenge(null); return; }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        if (inFlight.current) return;
        const result = await api.rootEmailManualCaptcha(jobId);
        if (disposed || inFlight.current) return;
        if (!result.success) { setChallenge(null); return; }
        const next: RootManualCaptchaView = result.data;
        if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(next.image)) throw new Error('验证码图片格式无效');
        if (challengeId.current !== next.challengeId) {
          challengeId.current = next.challengeId;
          setAnswer('');
        }
        setChallenge(next);
      } catch (cause: any) { if (!disposed) { setChallenge(null); setError(cause.message); } }
      finally { if (!disposed) timer = setTimeout(load, 2_000); }
    };
    void load();
    return () => { disposed = true; clearTimeout(timer); };
  }, [jobId, job?.manualCaptchaAvailable, revision]);

  const act = async (action: 'refresh' | 'submit') => {
    if (!jobId || !challenge || inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError('');
    const current = challenge;
    setChallenge(null);
    try {
      const result = await api.answerRootEmailManualCaptcha(jobId, { challengeId: current.challengeId, action,
        ...(action === 'submit' ? { captchaAnswer: answer.trim() } : {}) });
      if (!result.success) throw new Error(result.error || '操作未确认，请刷新验证码后查看');
    } catch (cause: any) { setError(cause.message); }
    finally {
      setAnswer(''); inFlight.current = false; setBusy(false); setRevision(value => value + 1); onProgress();
    }
  };
  return <Modal title={`手工输入验证码 · ${job?.accountId || ''}`} open={!!job} onCancel={onClose}
    maskClosable={false} destroyOnClose footer={<Space>
      <Button onClick={onClose}>关闭</Button>
      <Button disabled={!challenge || busy} onClick={() => void act('refresh')}>换一张图片</Button>
      <Button type="primary" loading={busy} disabled={!challenge || !/^[A-Za-z0-9]{6}$/.test(answer.trim())}
        onClick={() => void act('submit')}>提交验证码并继续</Button>
    </Space>}>
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Typography.Text>{job?.detail}</Typography.Text>
      {error && <Alert type="error" showIcon message={error} />}
      {challenge ? <>
        <Alert type="info" showIcon message={challenge.purpose === 'identity' ? '登录安全验证码' : '恢复邮件验证码'}
          description={`请在 ${new Date(challenge.expiresAt).toLocaleTimeString()} 前完成。等待期间后续账户暂缓处理；验证通过后任务会自动继续。`} />
        <img src={challenge.image} alt="当前 AWS 验证码" style={{ maxWidth: '100%', width: 300, objectFit: 'contain' }} />
        <Input aria-label="手工验证码" value={answer} maxLength={6} autoComplete="off" spellCheck={false}
          placeholder="输入图片中的 6 位字母或数字" onChange={event => setAnswer(event.target.value)}
          onPressEnter={() => { if (/^[A-Za-z0-9]{6}$/.test(answer.trim())) void act('submit'); }} />
      </> : job?.status === 'running' ? <Space><Spin size="small" /><Typography.Text>正在更新验证结果…</Typography.Text></Space>
        : <Alert type="info" showIcon message="请在任务列表查看后续结果" />}
    </Space>
  </Modal>;
}
