import React, { useState, useEffect } from 'react';
import { Card, Form, Input, Select, Button, message, Divider, Alert, Tag, Space, Popconfirm, List } from 'antd';
import { SaveOutlined, CheckCircleOutlined, DisconnectOutlined, PlusOutlined, DeleteOutlined, CloseCircleOutlined } from '@ant-design/icons';

const AWS_REGIONS = [
  { label: 'US East (N. Virginia) - us-east-1', value: 'us-east-1' },
  { label: 'US East (Ohio) - us-east-2', value: 'us-east-2' },
  { label: 'US West (Oregon) - us-west-2', value: 'us-west-2' },
  { label: 'EU (Ireland) - eu-west-1', value: 'eu-west-1' },
  { label: 'EU (Frankfurt) - eu-central-1', value: 'eu-central-1' },
  { label: 'Asia Pacific (Singapore) - ap-southeast-1', value: 'ap-southeast-1' },
  { label: 'Asia Pacific (Tokyo) - ap-northeast-1', value: 'ap-northeast-1' },
];

interface PayerEntry {
  roleArn: string;
  name: string;
}

interface SettingsPageProps {
  onConnected?: () => void;
}

const SettingsPage: React.FC<SettingsPageProps> = ({ onConnected }) => {
  const [form] = Form.useForm();
  const [connectionResults, setConnectionResults] = useState<any[]>([]);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [payers, setPayers] = useState<PayerEntry[]>([
    { roleArn: 'arn:aws:iam::133354366329:role/tool', name: 'yanhuang11' },
    { roleArn: 'arn:aws:iam::976592800319:role/tool', name: 'yanhuang14' },
  ]);
  const [newPayerArn, setNewPayerArn] = useState('');
  const [newPayerName, setNewPayerName] = useState('');

  useEffect(() => { checkConnection(); loadSavedConfig(); }, []);

  const loadSavedConfig = async () => {
    const result = await window.awsAPI.getSavedConfig();
    if (result.success && result.data) {
      form.setFieldsValue({
        accessKeyId: result.data.accessKeyId,
        region: result.data.region,
        childRoleName: result.data.childRoleName,
      });
      if (result.data.payers && result.data.payers.length > 0) {
        setPayers(result.data.payers);
      }
    }
  };

  const checkConnection = async () => {
    const hasCreds = await window.awsAPI.hasCredentials();
    if (hasCreds.data) {
      const result = await window.awsAPI.testConnection();
      if (result.success && result.data) {
        setConnected(true);
        setConnectionResults(result.data);
        onConnected?.();
      }
    }
  };

  const addPayer = () => {
    if (!newPayerArn || !newPayerName) { message.warning('请填写角色 ARN 和名称'); return; }
    if (payers.some(p => p.roleArn === newPayerArn)) { message.warning('该角色已存在'); return; }
    setPayers([...payers, { roleArn: newPayerArn, name: newPayerName }]);
    setNewPayerArn('');
    setNewPayerName('');
  };

  const removePayer = (arn: string) => {
    setPayers(payers.filter(p => p.roleArn !== arn));
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      if (payers.length === 0) { message.error('请至少添加一个 Payer 账户'); return; }
      setLoading(true);

      await window.awsAPI.configureCredentials({
        accessKeyId: values.accessKeyId,
        secretAccessKey: values.secretAccessKey,
        region: values.region,
        payers,
        childRoleName: values.childRoleName || 'OrganizationAccountAccessRole',
      });

      const testResult = await window.awsAPI.testConnection();
      if (testResult.success && testResult.data) {
        setConnected(true);
        setConnectionResults(testResult.data);
        const successCount = testResult.data.filter((r: any) => !r.error).length;
        message.success(`连接成功！${successCount}/${payers.length} 个 Payer 已连接`);
        onConnected?.();
      } else {
        setConnected(false);
        message.error(`连接失败: ${testResult.error}`);
      }
    } catch (err: any) {
      message.error(err.message || '请填写所有必填项');
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = async () => {
    await window.awsAPI.clearCredentials();
    setConnected(false);
    setConnectionResults([]);
    form.resetFields();
    message.info('已断开连接');
  };

  return (
    <div className="page-container">
      <div className="tool-card" style={{ maxWidth: 700 }}>
        <div className="tool-card-header">
          <span className="tool-card-title">设置</span>
          {connected && (
            <Popconfirm title="确认断开所有连接？" onConfirm={handleDisconnect} okText="确认" cancelText="取消" okButtonProps={{ danger: true }}>
              <Button size="small" danger icon={<DisconnectOutlined />}>断开</Button>
            </Popconfirm>
          )}
        </div>

        {/* Connection Status */}
        {connected && connectionResults.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            {connectionResults.map((r: any, i: number) => (
              <Alert key={i} type={r.error ? 'error' : 'success'} showIcon
                icon={r.error ? <CloseCircleOutlined /> : <CheckCircleOutlined />}
                message={`${r.name}: ${r.error ? '❌ ' + r.error : '✅ ' + r.account}`}
                style={{ marginBottom: 6 }} />
            ))}
          </div>
        )}

        <Form form={form} layout="vertical"
          initialValues={{ region: 'us-east-1', childRoleName: 'OrganizationAccountAccessRole' }}>

          <Divider orientation="left" plain style={{ fontSize: 12 }}>Tools 用户凭证</Divider>

          <Form.Item name="accessKeyId" label="Access Key ID" rules={[{ required: true, message: '必填' }]}>
            <Input placeholder="AKIAR6OJRZOOYQFIZSTC" autoComplete="off" />
          </Form.Item>
          <Form.Item name="secretAccessKey" label="Secret Access Key" rules={[{ required: true, message: '必填' }]}>
            <Input.Password placeholder="JTnqmIru0t51sLm..." autoComplete="off" />
          </Form.Item>

          <Divider orientation="left" plain style={{ fontSize: 12 }}>Payer 账户（管理角色）</Divider>

          <List
            size="small"
            bordered
            dataSource={payers}
            style={{ marginBottom: 12, borderRadius: 8 }}
            renderItem={(item) => (
              <List.Item
                actions={[<Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={() => removePayer(item.roleArn)} />]}
              >
                <Space>
                  <Tag color="blue">{item.name}</Tag>
                  <code style={{ fontSize: 11 }}>{item.roleArn}</code>
                </Space>
              </List.Item>
            )}
          />

          <Space style={{ marginBottom: 16 }}>
            <Input placeholder="名称 (e.g. yanhuang15)" value={newPayerName} onChange={e => setNewPayerName(e.target.value)} style={{ width: 140 }} size="small" />
            <Input placeholder="arn:aws:iam::XXXX:role/tool" value={newPayerArn} onChange={e => setNewPayerArn(e.target.value)} style={{ width: 280 }} size="small" />
            <Button size="small" icon={<PlusOutlined />} onClick={addPayer}>添加</Button>
          </Space>

          <Divider orientation="left" plain style={{ fontSize: 12 }}>其他配置</Divider>

          <Form.Item name="childRoleName" label="子账户角色名" tooltip="从 Payer 跳转到子账户时使用的角色名">
            <Input placeholder="OrganizationAccountAccessRole" />
          </Form.Item>
          <Form.Item name="region" label="默认区域" rules={[{ required: true }]}>
            <Select options={AWS_REGIONS} />
          </Form.Item>

          <Divider />
          <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} loading={loading} size="large" block>
            保存并验证连接
          </Button>
        </Form>

        <Alert
          message="多 Payer 架构"
          description={
            <div style={{ fontSize: 12, marginTop: 4 }}>
              <code style={{ display: 'block', padding: 8, background: 'var(--bg-secondary)', borderRadius: 6, margin: '6px 0' }}>
                tools AK/SK → AssumeRole → Payer1 (yanhuang11) → 子账户们<br/>
                {'            '}→ AssumeRole → Payer2 (yanhuang14) → 子账户们
              </code>
              <p style={{ marginTop: 6, color: 'var(--text-secondary)' }}>所有 Payer 下的账户会合并显示，自动判断归属关系。</p>
            </div>
          }
          type="info" showIcon style={{ marginTop: 16 }} />
      </div>
    </div>
  );
};

export default SettingsPage;
