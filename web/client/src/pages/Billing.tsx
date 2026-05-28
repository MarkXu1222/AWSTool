import React, { useState } from 'react';
import { Card, Table, Tag, Button, Space, message, Statistic, Row, Col, DatePicker, Input } from 'antd';
import { DollarOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { api } from '../api';
import { exportToCSV } from '../utils/export';

const { RangePicker } = DatePicker;

const BillingPage: React.FC = () => {
  const [costData, setCostData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [dateRange, setDateRange] = useState<[dayjs.Dayjs, dayjs.Dayjs]>([dayjs().subtract(1, 'month').startOf('month'), dayjs()]);
  const [totalCost, setTotalCost] = useState(0);
  const [searchText, setSearchText] = useState('');

  const fetchCosts = async () => {
    setLoading(true);
    try {
      const start = dateRange[0].format('YYYY-MM-DD');
      const end = dateRange[1].format('YYYY-MM-DD');
      const res = await api.getCostByAccount(start, end);
      if (res.success) {
        setCostData(res.data);
        let total = 0;
        (res.data || []).forEach((p: any) => (p.Groups || []).forEach((g: any) => { total += parseFloat(g.Metrics?.UnblendedCost?.Amount || '0'); }));
        setTotalCost(total);
      } else message.error(res.error);
    } catch (e: any) { message.error(e.message); }
    finally { setLoading(false); }
  };

  const tableData = costData.flatMap((p: any) => (p.Groups || []).map((g: any) => ({
    key: `${p.TimePeriod.Start}-${g.Keys[0]}`, period: `${p.TimePeriod.Start} ~ ${p.TimePeriod.End}`,
    accountId: g.Keys[0], cost: parseFloat(g.Metrics.UnblendedCost.Amount || '0'),
  }))).sort((a, b) => b.cost - a.cost);

  const filtered = tableData.filter(d => !searchText || d.accountId.includes(searchText));

  return (
    <div>
      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col xs={12} md={8}><Card size="small"><Statistic title="总费用" value={totalCost} precision={2} prefix={<DollarOutlined />} suffix="USD" valueStyle={{ color: '#ff9500' }} /></Card></Col>
        <Col xs={12} md={8}><Card size="small"><Statistic title="账户数" value={new Set(tableData.map(d => d.accountId)).size} /></Card></Col>
      </Row>
      <Card size="small" title="💰 账单" extra={<Button size="small" onClick={() => exportToCSV(filtered.map(d => ({ 账期: d.period, 账户: d.accountId, '费用(USD)': d.cost.toFixed(4) })), 'billing')}>导出</Button>}>
        <Space wrap style={{ marginBottom: 8 }}>
          <RangePicker value={dateRange} onChange={(d) => { if (d?.[0] && d?.[1]) setDateRange([d[0], d[1]]); }} picker="month" size="small" />
          <Button icon={<ReloadOutlined />} onClick={fetchCosts} loading={loading} type="primary" size="small">查询</Button>
        </Space>
        <Input placeholder="搜索账户ID..." prefix={<SearchOutlined />} value={searchText} onChange={e => setSearchText(e.target.value)} allowClear size="small" style={{ marginBottom: 8, maxWidth: 250 }} />
        <Table size="small" dataSource={filtered} loading={loading} pagination={{ pageSize: 20 }} rowKey="key"
          columns={[
            { title: '账期', dataIndex: 'period' },
            { title: '账户 ID', dataIndex: 'accountId', render: (id: string) => <code>{id}</code> },
            { title: '费用', dataIndex: 'cost', sorter: (a: any, b: any) => a.cost - b.cost, render: (c: number) => <span style={{ fontWeight: 600, color: c > 100 ? '#ff3b30' : c > 10 ? '#ff9500' : '#34c759' }}>${c.toFixed(2)}</span> },
            { title: '占比', key: 'pct', render: (_: any, r: any) => <Tag color="blue">{totalCost > 0 ? ((r.cost / totalCost) * 100).toFixed(1) : 0}%</Tag> },
          ]} />
      </Card>
    </div>
  );
};

export default BillingPage;
