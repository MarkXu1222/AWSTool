import React, { useState, useEffect } from 'react';
import { Card, Table, Tag, message } from 'antd';
import { api } from '../api';

interface AuditEntry {
  created_at: string;
  action: string;
  detail: string;
}

const actionColors: Record<string, string> = {
  LOGIN: 'blue',
  QUOTA_INCREASE: 'orange',
  PASSWORD_CHANGE: 'green',
};

const AuditLogPage: React.FC = () => {
  const [logs, setLogs] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { fetchLogs(); }, []);

  const fetchLogs = async () => {
    try {
      const res = await api.getAuditLog();
      setLogs(res.data || res || []);
    } catch (e: any) {
      message.error('加载审计日志失败');
    } finally {
      setLoading(false);
    }
  };

  const columns = [
    {
      title: '时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 160,
      render: (t: string) => new Date(t).toLocaleString('zh-CN'),
    },
    {
      title: '操作',
      dataIndex: 'action',
      key: 'action',
      width: 120,
      render: (action: string) => (
        <Tag color={actionColors[action] || 'default'}>{action}</Tag>
      ),
    },
    {
      title: '详情',
      dataIndex: 'detail',
      key: 'detail',
    },
  ];

  return (
    <div style={{ maxWidth: 700 }}>
      <Card size="small" title="📋 审计日志">
        <Table
          dataSource={logs}
          columns={columns}
          rowKey={(r, i) => `${r.created_at}-${i}`}
          size="small"
          loading={loading}
          pagination={{ pageSize: 20 }}
          scroll={{ x: 400 }}
        />
      </Card>
    </div>
  );
};

export default AuditLogPage;
