import React, { useState } from 'react';
import { Modal, Input, Alert, Space, Tag } from 'antd';
import { ExclamationCircleOutlined, WarningOutlined } from '@ant-design/icons';

interface DangerConfirmProps {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmText: string; // 用户必须输入的确认文字
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
}

/**
 * 高敏感操作二次确认组件
 * 用户必须手动输入指定文字才能执行操作
 */
const DangerConfirm: React.FC<DangerConfirmProps> = ({
  open, title, description, confirmText, onConfirm, onCancel, loading,
}) => {
  const [inputValue, setInputValue] = useState('');

  const isMatch = inputValue === confirmText;

  const handleCancel = () => {
    setInputValue('');
    onCancel();
  };

  const handleOk = () => {
    if (isMatch) {
      setInputValue('');
      onConfirm();
    }
  };

  return (
    <Modal
      open={open}
      title={
        <Space>
          <ExclamationCircleOutlined style={{ color: '#ff4d4f', fontSize: 20 }} />
          <span style={{ color: '#ff4d4f', fontWeight: 700 }}>{title}</span>
        </Space>
      }
      onCancel={handleCancel}
      onOk={handleOk}
      okText="确认执行"
      cancelText="取消"
      okButtonProps={{ danger: true, disabled: !isMatch, loading }}
      width={520}
      centered
    >
      <Alert
        message="⚠️ 此操作不可逆"
        description="执行后数据将永久删除，无法恢复。请务必确认。"
        type="error"
        showIcon
        icon={<WarningOutlined />}
        style={{ marginBottom: 16 }}
      />

      <div style={{ marginBottom: 16 }}>
        {description}
      </div>

      <div style={{ marginBottom: 8 }}>
        <span>请输入 </span>
        <Tag color="red" style={{ fontSize: 14, padding: '2px 8px' }}>{confirmText}</Tag>
        <span> 以确认操作：</span>
      </div>

      <Input
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        placeholder={`请输入: ${confirmText}`}
        status={inputValue && !isMatch ? 'error' : undefined}
        size="large"
        autoFocus
        onPressEnter={handleOk}
      />

      {inputValue && !isMatch && (
        <div style={{ color: '#ff4d4f', marginTop: 4, fontSize: 12 }}>
          输入不匹配，请重新输入
        </div>
      )}
    </Modal>
  );
};

export default DangerConfirm;
