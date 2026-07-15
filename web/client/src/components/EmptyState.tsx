import React from 'react';
import { Button } from 'antd';
import { InboxOutlined } from '@ant-design/icons';

interface EmptyStateProps {
  description?: React.ReactNode;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  actionText?: string;
  onAction?: () => void;
  style?: React.CSSProperties;
}

/**
 * 统一空状态：图标 + 说明 +（可选）二级提示 +（可选）引导按钮。
 * 用于表格 emptyText、页面初始引导等，保证全站空态观感一致。
 */
const EmptyState: React.FC<EmptyStateProps> = ({ description = '暂无数据', hint, icon, actionText, onAction, style }) => (
  <div style={{ padding: '44px 16px', textAlign: 'center', ...style }}>
    <div style={{ fontSize: 46, color: '#cbd2de', marginBottom: 12, lineHeight: 1 }}>
      {icon || <InboxOutlined />}
    </div>
    <div style={{ color: '#4a5468', fontSize: 14, fontWeight: 500 }}>{description}</div>
    {hint && <div style={{ color: '#8a94a6', fontSize: 12, marginTop: 4 }}>{hint}</div>}
    {actionText && onAction && (
      <div style={{ marginTop: 16 }}>
        <Button type="primary" onClick={onAction}>{actionText}</Button>
      </div>
    )}
  </div>
);

export default EmptyState;
