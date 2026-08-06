/**
 * 提额文档模板数据
 * - 公司背景：每家固定（统一模板）
 * - 配额类型：AWS 官方名称映射
 * - 区域：代码 → 显示名
 */

export interface CompanyProfile {
  key: string;
  displayName: string;       // 文档里的公司名
  industry: string;          // 行业
  summary: string;           // Project Summary 公司背景段落（统一）
  migrationBackground: string;
  coreBusiness: string;
  technicalArchitecture: string;
  sourceCloud: string;       // 来源云（Alibaba Cloud / IDC / Huawei Cloud）
  archImage: string;         // 架构图文件名（doc-templates/architectures/）
  // 资源拆解的业务组件模板（按 vCPU 比例分配）
  resourceComponents: { name: string; useType: string; purpose: string; weight: number }[];
}

// 公司背景库（账户ID → 公司）
export const COMPANY_PROFILES: Record<string, CompanyProfile> = {
  skymora: {
    key: 'skymora',
    displayName: 'Skymora',
    industry: 'Web3 / Decentralized Commerce',
    summary: `Skymora is a Web3 company operating across multiple decentralized technology domains. One of its flagship projects is a live B2B platform designed to transform the way micro, small, and medium-sized enterprises (MSMEs) interact in business. The platform enables these businesses to unlock and trade their surplus value and idle capacity. At the heart of this platform lies Skymora's "Decentralized Commerce Engine", which converts underutilized corporate assets—such as excess inventory, billable hours, or unused operational capacity—into tradable digital tokens. Supported by both on-chain and off-chain data analytics, the platform provides stability and liquidity for B2B economic activities among its members.`,
    migrationBackground: `The existing platform is running on Alibaba Cloud, with plans to complete the migration of major modules to AWS within the next 3–6 months. During the migration, a dual-cluster operation (parallel operation of Alibaba Cloud and AWS) is required, thus the initial vCPU demand for AWS is relatively high.`,
    coreBusiness: `Decentralized commerce engine, on-chain and off-chain data analytics, B2B asset tokenization, order management, inventory synchronization, and large-scale data processing all require high-performance computing resources.`,
    technicalArchitecture: `A multi-VPC, multi-subnet layered architecture is adopted, combined with cross-availability zone disaster recovery, to support decentralized commerce operations and global API integration.`,
    sourceCloud: 'Alibaba Cloud',
    archImage: 'skymora.png',
    resourceComponents: [
      { name: 'Decentralized Commerce Engine', useType: 'Core services', purpose: 'Support token conversion and B2B matching workloads.', weight: 0.25 },
      { name: 'Data Analytics & Reporting', useType: 'BI/ETL workloads', purpose: 'On-chain/off-chain analytics and reporting consistency.', weight: 0.20 },
      { name: 'Order & Inventory Services', useType: 'Core platform', purpose: 'Order and inventory synchronization and parallel operation.', weight: 0.18 },
      { name: 'Settlement & Risk Systems', useType: 'Financial ops', purpose: 'Settlement processing and risk control calculation.', weight: 0.15 },
      { name: 'API & Integration Layer', useType: 'Integration', purpose: 'Global API integration and member access.', weight: 0.12 },
      { name: 'Development & Staging Servers', useType: 'QA/test', purpose: 'Parallel testing and verification of the migration process.', weight: 0.10 },
    ],
  },
  avants: {
    key: 'avants',
    displayName: 'Avants',
    industry: 'Digital Entertainment / Gaming',
    summary: `Avants is a leading digital entertainment and gaming platform ecosystem in Southeast Asia, encompassing both Mobile Apps and PC Clients. Currently, the core platform operates in a traditional IDC (Internet Data Center) environment, running approximately 155 Linux Virtual Machines with self-hosted databases (MySQL, MongoDB) and Redis clusters. To modernize the infrastructure, achieve a target of 30% TCO (Total Cost of Ownership) savings, and leverage cloud elasticity to handle high-concurrency traffic during e-sports tournaments, the company plans to re-platform and migrate its core workloads to AWS.`,
    migrationBackground: `The existing gaming platform and backend services are running on on-premise IDCs. The plan is to modernize these applications into a containerized architecture using Amazon EKS, while migrating data layers to managed services like Amazon RDS and Amazon ElastiCache. During the migration window, a "dual-run" strategy will be employed where the new AWS environment must fully scale up to validate performance before the IDC is decommissioned.`,
    coreBusiness: `Real-time game server hosting, matchmaking services, player session management, tournament management, digital asset distribution, and e-sports event live-streaming support.`,
    technicalArchitecture: `The target architecture utilizes Amazon EKS for microservices, Amazon RDS for persistent player data, and Amazon ElastiCache for high-speed leaderboards and session caching, deployed across multiple availability zones.`,
    sourceCloud: 'On-premise IDC',
    archImage: 'avants.png',
    resourceComponents: [
      { name: 'Game Server Hosting', useType: 'Core services', purpose: 'Real-time game server instances and session management.', weight: 0.25 },
      { name: 'Matchmaking & Live Services', useType: 'Core platform', purpose: 'Matchmaking, leaderboards, and live operations.', weight: 0.20 },
      { name: 'Data & Persistence Layer', useType: 'Database ops', purpose: 'Player data, transactions, and caching.', weight: 0.18 },
      { name: 'EKS Microservices', useType: 'Containerized', purpose: 'Containerized backend microservices.', weight: 0.15 },
      { name: 'Streaming & Media', useType: 'Media ops', purpose: 'E-sports live-streaming and content delivery.', weight: 0.12 },
      { name: 'Development & Staging', useType: 'QA/test', purpose: 'Parallel testing during dual-run migration.', weight: 0.10 },
    ],
  },
  buminiaga: {
    key: 'buminiaga',
    displayName: 'BUMI NIAGA TRADING',
    industry: 'Fintech / Trade Finance',
    summary: `BUMI NIAGA TRADING, founded in 2025 and headquartered in Kuala Lumpur, Malaysia, is an innovative fintech company focused on providing intelligent risk management and trade finance solutions for small and medium-sized enterprises (SMEs). The company's mission is to reshape the trade finance landscape in Southeast Asia through AI-driven risk control technology and intelligent financial services. Its flagship product is an AI-powered smart trade finance platform, designed to help global SMEs reduce the risks associated with cross-border transactions and improve the efficiency of capital flow. At the core of the platform is the Intelligent Risk Control Engine, capable of analyzing real-time user behavior, market trends, and transaction data to deliver accurate risk assessments, credit management, and fraud prevention solutions.`,
    migrationBackground: `BUMI NIAGA TRADING is currently migrating its major ERP and business modules from Alibaba Cloud to AWS over the next 3–6 months. During this migration window, a dual-run operation is required to ensure business continuity, data consistency, and controlled validation before full cutover.`,
    coreBusiness: `Customer onboarding, SME credit/risk assessment workflows, trade finance transaction processing, reporting dashboards, and operational support tools.`,
    technicalArchitecture: `A secure VPC-based architecture is deployed, with the Intelligent Risk Control Engine, transaction processing, and analytics layers distributed across multiple availability zones, connected to managed services such as Amazon RDS.`,
    sourceCloud: 'Alibaba Cloud',
    archImage: 'buminiaga.jpeg',
    resourceComponents: [
      { name: 'Risk Control Engine', useType: 'Core AI services', purpose: 'Real-time risk assessment and fraud prevention.', weight: 0.25 },
      { name: 'Trade Finance Processing', useType: 'Core platform', purpose: 'Cross-border transaction processing.', weight: 0.20 },
      { name: 'Data Analytics & Reporting', useType: 'BI/ETL workloads', purpose: 'Market trend and behavior analysis.', weight: 0.18 },
      { name: 'Customer & Credit Services', useType: 'CRM operations', purpose: 'SME onboarding and credit management.', weight: 0.15 },
      { name: 'API & Integration Layer', useType: 'Integration', purpose: 'Partner and payment system integration.', weight: 0.12 },
      { name: 'Development & Staging', useType: 'QA/test', purpose: 'Parallel validation during migration.', weight: 0.10 },
    ],
  },
  dldata: {
    key: 'dldata',
    displayName: 'DL Data A.I.d.',
    industry: 'Enterprise AI / Data Platform',
    summary: `DL Data A.I.d. is a Malaysia-based enterprise AI company that specializes in large-scale customer signal ingestion and NLP-driven insight generation. The company operates and manages an enterprise-facing VOC (Voice of Customer) data platform that helps organizations convert fragmented, multi-channel customer communications into structured, decision-ready intelligence. The platform supports data collection from sources such as surveys, contact-center transcripts, email, chat, e-commerce reviews, social channels, and voice data, and provides core AI capabilities including sentiment analysis, topic classification, intent understanding, taxonomy management, dashboard visualization, offline model training, and online inference.`,
    migrationBackground: `DL Data A.I.d. currently operates its VOC platform with a cloud-based architecture. The company plans to migrate its data access, training, inference, customer-facing APIs, and analytics delivery to AWS over the next 3–6 months, requiring sufficient compute capacity during the dual-run validation phase.`,
    coreBusiness: `Multi-channel customer signal ingestion, NLP-driven sentiment and intent analysis, model training and inference, dashboard visualization, and enterprise API delivery.`,
    technicalArchitecture: `A secure multi-tenant VPC architecture supporting scalable data processing pipelines, reliable model inference, auditable data governance, and high availability across multiple availability zones.`,
    sourceCloud: 'Cloud-based platform',
    archImage: 'dldata.png',
    resourceComponents: [
      { name: 'Model Training & Inference', useType: 'AI/ML workloads', purpose: 'Offline model training and online inference.', weight: 0.28 },
      { name: 'Data Ingestion Pipelines', useType: 'Data Ops', purpose: 'Multi-channel signal ingestion and normalization.', weight: 0.20 },
      { name: 'NLP Analytics Engine', useType: 'Core AI services', purpose: 'Sentiment, topic, and intent analysis.', weight: 0.18 },
      { name: 'Customer APIs & Dashboards', useType: 'Customer-facing', purpose: 'Enterprise API delivery and visualization.', weight: 0.14 },
      { name: 'Data Governance & Export', useType: 'Governance', purpose: 'Auditable data governance and downstream export.', weight: 0.10 },
      { name: 'Development & Staging', useType: 'QA/test', purpose: 'Parallel testing during migration.', weight: 0.10 },
    ],
  },
  malasoftware: {
    key: 'malasoftware',
    displayName: 'Malasoftware',
    industry: 'ERP / Cross-border E-commerce',
    summary: `Malasoftware is a company focused on ERP e-commerce systems, primarily serving cross-border e-commerce clients in Southeast Asia and globally. Currently, the core business system operates on Alibaba Cloud. Due to the globalization of business expansion and reliance on AWS's more robust ecosystem and global network, the company plans to migrate its core ERP cluster to AWS.`,
    migrationBackground: `The existing ERP platform is running on Alibaba Cloud, with plans to complete the migration of major modules to AWS within the next 3–6 months. During the migration, a dual-cluster operation (parallel operation of Alibaba Cloud and AWS) is required, thus the initial vCPU demand for AWS is relatively high.`,
    coreBusiness: `Order management, inventory synchronization, cross-border supply chain tracking, financial settlement, customer relationship management, and large-scale promotional activities.`,
    technicalArchitecture: `A multi-VPC, multi-subnet layered architecture is adopted, combined with cross-availability zone disaster recovery, to support multi-language e-commerce operations and global API integration.`,
    sourceCloud: 'Alibaba Cloud',
    archImage: 'malasoftware.png',
    resourceComponents: [
      { name: 'Order & Inventory Services', useType: 'Core ERP services', purpose: 'Order and inventory migration and parallel operation.', weight: 0.22 },
      { name: 'Supply Chain Tracking', useType: 'Core platform', purpose: 'Cross-border supply chain tracking.', weight: 0.18 },
      { name: 'Payment & Settlement', useType: 'Financial ops', purpose: 'Payment system and risk control calculation.', weight: 0.16 },
      { name: 'Data Analytics & Reporting', useType: 'BI/ETL workloads', purpose: 'Data warehouse migration and reporting.', weight: 0.16 },
      { name: 'CRM & Marketing Systems', useType: 'CRM operations', purpose: 'Customer service and promotion engines.', weight: 0.16 },
      { name: 'Development & Staging', useType: 'QA/test', purpose: 'Parallel testing and verification.', weight: 0.12 },
    ],
  },
  taosource: {
    key: 'taosource',
    displayName: 'Tao-Source Technologies (Malaysia) Sdn Bhd',
    industry: 'E-commerce / AI Retail',
    summary: `Tao-Source Technologies (Malaysia) Sdn Bhd, founded in 2024 and headquartered in Kuala Lumpur, Malaysia, is an innovative e-commerce technology company focused on building the next-generation online retail platform. With the mission to "reshape the retail landscape through AI-driven personalization and seamless shopping experiences," the company is committed to creating a future-ready e-commerce infrastructure tailored for the Southeast Asian market. The company's flagship product is its AI-powered e-commerce platform, with the AI Personalization Engine at its core, capable of analyzing real-time user behavior, product trends, and market data to deliver precise recommendations, dynamic pricing, and seamless checkout experiences.`,
    migrationBackground: `Tao-Source is migrating its core e-commerce platform to AWS over the next 3–6 months. During the migration, a dual-run operation is required to ensure business continuity and validate performance before full cutover.`,
    coreBusiness: `AI-driven product recommendations, dynamic pricing, personalized marketing, shopping cart management, checkout workflows, and order processing.`,
    technicalArchitecture: `A multi-VPC, multi-subnet layered architecture with cross-availability zone disaster recovery, supporting the AI Personalization Engine, e-commerce operations, and global API integration.`,
    sourceCloud: 'Alibaba Cloud',
    archImage: 'taosource.png',
    resourceComponents: [
      { name: 'AI Personalization Engine', useType: 'Core AI services', purpose: 'Real-time recommendations and dynamic pricing.', weight: 0.25 },
      { name: 'Order & Checkout Services', useType: 'Core platform', purpose: 'Cart management, checkout, and order processing.', weight: 0.20 },
      { name: 'Data Analytics & Reporting', useType: 'BI/ETL workloads', purpose: 'User behavior and market trend analysis.', weight: 0.18 },
      { name: 'Product & Catalog Services', useType: 'Core services', purpose: 'Product discovery and catalog management.', weight: 0.15 },
      { name: 'Marketing & Campaign', useType: 'Promotion engines', purpose: 'Personalized marketing and campaigns.', weight: 0.12 },
      { name: 'Development & Staging', useType: 'QA/test', purpose: 'Parallel testing during migration.', weight: 0.10 },
    ],
  },
  taovolt: {
    key: 'taovolt',
    displayName: 'Taovolt',
    industry: 'Autonomous Driving',
    summary: `Taovolt is a company focused on autonomous driving solutions, primarily serving clients in the Asia-Pacific region. Currently, the core data processing and simulation platform operates on Alibaba Cloud. Due to the globalization of business expansion and reliance on AWS's more robust ecosystem and global network, the company plans to migrate its core compute and data cluster to AWS.`,
    migrationBackground: `The existing data processing and simulation platform is running on Alibaba Cloud, with plans to migrate major compute modules to AWS within the next 3–6 months. During the migration, a dual-cluster operation is required.`,
    coreBusiness: `Autonomous driving data processing, large-scale simulation, sensor data analytics, model training, and validation workloads.`,
    technicalArchitecture: `A multi-VPC, multi-subnet layered architecture combined with cross-availability zone disaster recovery, supporting compute-intensive simulation and data analytics workloads.`,
    sourceCloud: 'Alibaba Cloud',
    archImage: 'taovolt.png',
    resourceComponents: [
      { name: 'Simulation Compute Cluster', useType: 'Core compute', purpose: 'Large-scale autonomous driving simulation.', weight: 0.30 },
      { name: 'Data Processing Pipelines', useType: 'Data Ops', purpose: 'Sensor and telemetry data processing.', weight: 0.22 },
      { name: 'Model Training & Validation', useType: 'AI/ML workloads', purpose: 'Model training and validation.', weight: 0.18 },
      { name: 'Analytics & Reporting', useType: 'BI/ETL workloads', purpose: 'Data analytics and reporting.', weight: 0.14 },
      { name: 'Development & Staging', useType: 'QA/test', purpose: 'Parallel testing during migration.', weight: 0.16 },
    ],
  },
  zyronix: {
    key: 'zyronix',
    displayName: 'Zyronix',
    industry: 'E-commerce / Online Retail',
    summary: `Zyronix is an e-commerce technology company based in Indonesia that operates and manages a consumer-facing online retail platform serving customers through web and API-driven services. The platform supports core commerce functions including product discovery, shopping cart management, checkout workflows, and order processing. As a revenue-generating and business-critical system, the platform requires high availability, low-latency performance, transactional consistency, and the ability to scale reliably during peak demand and promotional periods. Zyronix currently operates its production environment in a centralized on-premises data center consisting of approximately 30–35 physical servers hosting 140–160 virtual machines, with a transactional data tier of approximately 10–12 TB.`,
    migrationBackground: `Zyronix currently operates its production environment in a centralized on-premises data center. As business demand has increased, the limitations of the on-premises environment (fixed capacity, hardware-bound scaling, limited elasticity, manual backup processes) have become more pronounced. The company plans to migrate its revenue-critical platform to AWS, requiring a dual-run period to ensure business continuity.`,
    coreBusiness: `Product discovery, shopping cart management, checkout workflows, order processing, payments, and inventory management.`,
    technicalArchitecture: `A secure VPC-based architecture with Multi-AZ deployment, supporting Linux and Windows application services, transactional SQL database tier, and automated cross-site failover for disaster recovery.`,
    sourceCloud: 'On-premises data center',
    archImage: 'zyronix.png',
    resourceComponents: [
      { name: 'Application Services', useType: 'Core services', purpose: 'Linux-based application and background processing.', weight: 0.25 },
      { name: 'Order & Checkout Services', useType: 'Core platform', purpose: 'Cart, checkout, and order processing.', weight: 0.20 },
      { name: 'Transactional Data Tier', useType: 'Database ops', purpose: 'Orders, payments, customer data, inventory.', weight: 0.18 },
      { name: 'Analytics Workloads', useType: 'BI/ETL workloads', purpose: 'Business analytics and reporting.', weight: 0.15 },
      { name: 'Platform-specific Services', useType: 'Windows services', purpose: 'Stateful and platform-specific services.', weight: 0.12 },
      { name: 'Development & Staging', useType: 'QA/test', purpose: 'Parallel validation during migration.', weight: 0.10 },
    ],
  },
  taiping: {
    key: 'taiping',
    displayName: 'China Taiping Insurance (Singapore) Pte. Ltd.',
    industry: 'Insurance / Financial Services',
    summary: `China Taiping Insurance (Singapore) Pte. Ltd. ("China Taiping (Singapore)") is an insurance company operating in Singapore and a subsidiary of China Taiping Insurance Group. The company focuses on providing life insurance products and related protection services, supporting core business functions such as policy administration, underwriting, claims processing, and customer service through digital channels and partner integrations. As a regulated financial institution, China Taiping (Singapore) is subject to increasingly stringent national and regulatory requirements on data protection, information security, and auditability.`,
    migrationBackground: `China Taiping (Singapore)'s life insurance core system is currently hosted on Huawei Cloud Singapore Region. To better meet national data compliance and security requirements, and to align with internationally accepted information security and data protection standards, the company has decided to migrate its life insurance core system from Huawei Cloud to AWS, which provides a mature security and compliance framework with native services for auditability, encryption, access control, and continuous security monitoring.`,
    coreBusiness: `Policy administration, underwriting, claims processing, customer service, and partner integrations through digital channels.`,
    technicalArchitecture: `A secure, compliant cloud foundation with Multi-AZ high availability, disaster recovery, native governance services for centralized audit logging, encryption and key management, and continuous security monitoring.`,
    sourceCloud: 'Huawei Cloud',
    archImage: 'taiping.png',
    resourceComponents: [
      { name: 'Policy Core System', useType: 'Core services', purpose: 'Policy administration and underwriting.', weight: 0.25 },
      { name: 'Claims Processing', useType: 'Core platform', purpose: 'Claims processing workflows.', weight: 0.18 },
      { name: 'Customer-facing Services', useType: 'Customer ops', purpose: 'Digital channels and customer service.', weight: 0.16 },
      { name: 'High Availability & DR', useType: 'HA/DR', purpose: 'High availability architecture and disaster recovery.', weight: 0.16 },
      { name: 'Non-production Environments', useType: 'QA/test', purpose: 'Non-production and validation environments.', weight: 0.13 },
      { name: 'Partner Integration Layer', useType: 'Integration', purpose: 'External partner and internal system integration.', weight: 0.12 },
    ],
  },

  malatrading: {
    key: 'malatrading',
    displayName: 'Malatrading',
    industry: 'Cross-border E-commerce',
    summary: `Malatrading is a Malaysia-registered e-commerce company focused on the development, operation, and product sales of cross-border e-commerce platforms. Dedicated to building a global e-commerce ecosystem, Malatrading emphasizes technological innovation and user experience as its core driving forces. Its online shopping platform offers a wide range of products, from electronics to home goods, meeting the needs of consumers in Southeast Asia and around the world.`,
    migrationBackground: `Malatrading's e-commerce platform currently operates on Alibaba Cloud, with key services containerized via ACK (Alibaba Cloud Kubernetes). These services support high-traffic modules including order processing, payment gateways, membership systems, product recommendation engines, and data analytics. In the migration plan, all core applications and supporting services will be transitioned to AWS, with the target architecture comprising Amazon EKS, RDS (Aurora), Amazon OpenSearch, and Amazon S3. During the transition, a dual-run period is required to ensure business continuity.`,
    coreBusiness: `Order processing, payment gateways, membership systems, product recommendation engines, and large-scale data analytics for cross-border shopping operations.`,
    technicalArchitecture: `The target architecture comprises Amazon EKS for container orchestration, RDS (Aurora) and Amazon OpenSearch for data, Amazon S3 for static content, and a GitLab + Jenkins CI/CD pipeline, deployed across multiple availability zones with centralized logging and IAM governance.`,
    sourceCloud: 'Alibaba Cloud',
    archImage: 'malatrading.png',
    resourceComponents: [
      { name: 'E-commerce Services (EKS)', useType: 'Core services', purpose: 'Containerized order, payment, and membership services.', weight: 0.28 },
      { name: 'Product Recommendation Engine', useType: 'Core platform', purpose: 'Recommendation and personalization workloads.', weight: 0.18 },
      { name: 'Data Analytics Platform', useType: 'BI/ETL workloads', purpose: 'Big data analytics, Glue and Athena pipelines.', weight: 0.18 },
      { name: 'Payment & Membership', useType: 'Financial ops', purpose: 'Payment gateway and membership systems.', weight: 0.14 },
      { name: 'Middleware & Caching', useType: 'Middleware', purpose: 'Redis, Kafka, and MongoDB equivalents.', weight: 0.12 },
      { name: 'Development & Staging', useType: 'QA/test', purpose: 'Parallel validation during migration.', weight: 0.10 },
    ],
  },

  osstable: {
    key: 'osstable',
    displayName: 'Osstable',
    industry: 'Online Gaming / MMORPG',
    summary: `Osstable is a technology company headquartered in Malaysia, focusing on global online entertainment and digital interactive experiences. The company's regional operations center is located in Malaysia, which is the core hub of its Southeast Asian strategy. Osstable is committed to creating immersive virtual worlds and real-time interactive experiences, mainly for mobile and PC platform users, with target markets covering Southeast Asian countries such as Indonesia, Thailand, the Philippines, and Singapore, with plans to expand to global players. The company is accelerating its overseas cloud infrastructure transformation to support high availability, low latency, and global coverage deployment of next-generation massively multiplayer online role-playing game (MMORPG) services.`,
    migrationBackground: `Osstable is migrating the backend of its flagship online role-playing game from Alibaba Cloud (Malaysia Region) to AWS for enhanced scalability, observability, and regional compliance. The migration covers core services such as authentication, matchmaking, payment processing, player profile management, inventory and item systems, leaderboards, and real-time analytics. The company is moving from a single-AZ deployment to a multi-availability zone architecture, requiring a dual-run period to ensure service continuity.`,
    coreBusiness: `Login/authentication systems, battle matchmaking, recharge payment, character management, inventory and item systems, leaderboards, and real-time data analysis for MMORPG services.`,
    technicalArchitecture: `The future architecture includes Amazon EKS for microservices, Aurora and DynamoDB for databases, Amazon EMR + S3 and OpenSearch Service for analytics, CloudFront CDN for global game delivery, and CloudWatch Logs for observability, deployed across multiple availability zones for fault tolerance and PDPA/GDPR compliance.`,
    sourceCloud: 'Alibaba Cloud',
    archImage: 'osstable.png',
    resourceComponents: [
      { name: 'Game Server Cluster (EKS)', useType: 'Core services', purpose: 'Authentication, matchmaking, and game session services.', weight: 0.28 },
      { name: 'Real-time Battle & Matching', useType: 'Core platform', purpose: 'Battle matching and real-time interaction.', weight: 0.20 },
      { name: 'Player Data & Inventory', useType: 'Database ops', purpose: 'Character management, inventory, and leaderboards.', weight: 0.16 },
      { name: 'Real-time Analytics (EMR)', useType: 'BI/ETL workloads', purpose: 'Behavior tracking and user retention models.', weight: 0.14 },
      { name: 'Payment & Recharge', useType: 'Financial ops', purpose: 'Recharge payment processing.', weight: 0.12 },
      { name: 'Development & Staging', useType: 'QA/test', purpose: 'Parallel validation during migration.', weight: 0.10 },
    ],
  },

  taxismap: {
    key: 'taxismap',
    displayName: 'TaxisMap Technologies Limited',
    industry: 'Connected Vehicle / IoV',
    summary: `TaxisMap Technologies Limited was established in Malaysia in 2020, providing core software architecture from vehicle to cloud for automotive companies, and quickly customizing software products and cloud business systems for specific parts according to vehicle models. The company's connected vehicle (Internet of Vehicles) system platform uploads data collected from vehicles to the cloud via MQTT over the Internet. TaxisMap, Yanhuang, and AWS reached a comprehensive strategic cooperation in 2025 Q1 to enhance its overall connected vehicle service competitiveness internationally and promote the establishment of a customer globalization system.`,
    migrationBackground: `TaxisMap's connected vehicle system platform is currently deployed in Alibaba Cloud Malaysia Region, using ACK to deploy containerized connected vehicle applications. The migration target is the entire vehicle networking platform, with data processing during the transition phase relying on a dedicated line between AWS and Alibaba Cloud. The company is migrating to AWS to leverage global infrastructure capacity and overseas advantages.`,
    coreBusiness: `Vehicle data ingestion via MQTT, connected vehicle application processing, user profile and behavior generation, in-depth vehicle data analysis, and global connected vehicle solutions.`,
    technicalArchitecture: `The target architecture uses Amazon EKS for containerized connected vehicle applications, RDS and KV store databases for business data, Amazon S3 for vehicle-uploaded static files, and analytics platforms for vehicle data analysis, deployed across multiple availability zones.`,
    sourceCloud: 'Alibaba Cloud',
    archImage: 'taxismap.jpeg',
    resourceComponents: [
      { name: 'Connected Vehicle App (EKS)', useType: 'Core services', purpose: 'Containerized vehicle data processing applications.', weight: 0.28 },
      { name: 'MQTT Data Ingestion', useType: 'Data Ops', purpose: 'Real-time vehicle data ingestion pipelines.', weight: 0.20 },
      { name: 'Data Analytics Platform', useType: 'BI/ETL workloads', purpose: 'Vehicle data analysis and user profiling.', weight: 0.18 },
      { name: 'Message Queue (RocketMQ)', useType: 'Middleware', purpose: 'Real-time messaging and event processing.', weight: 0.14 },
      { name: 'Data & Storage Tier', useType: 'Database ops', purpose: 'RDS, KV store, and S3 storage.', weight: 0.10 },
      { name: 'Development & Staging', useType: 'QA/test', purpose: 'Parallel validation during migration.', weight: 0.10 },
    ],
  },
};

// 账户ID → 公司key 映射（基于 config.json payer 名称，对照文档库确认）
export const ACCOUNT_TO_COMPANY: Record<string, string> = {
  '133354366329': 'skymora',      // yanhuang11-skymora
  '976592800319': 'dldata',       // yanhuang14-DLDAte
  '820242927609': 'malatrading',  // yanhuang2-malatrading
  '577578676580': 'zyronix',      // yanhuang19-zyronix
  '314146334864': 'taxismap',     // yanhuang1-taximap
  '724772095868': 'taovolt',      // yanhuang3-taoVolt
  '343218184773': 'malasoftware', // yanhuang4-malasoftware
  '023020468236': 'osstable',     // yanhuang6-ostable
  '424016505663': 'buminiaga',    // yanhuang12-buminiaga
  '770017447024': 'taosource',    // yanhuang10-tao-source
  '326280737814': 'avants',       // yanhuang16-avants
};

// Payer 组织名 → 公司key 映射（子账户通过 _payer 字段匹配）
export const PAYER_TO_COMPANY: Record<string, string> = {
  // 完整名（新）
  'yanhuang11-skymora': 'skymora',
  'yanhuang14-DLDAte': 'dldata',
  'yanhuang2-malatrading': 'malatrading',
  'yanhuang19-zyronix': 'zyronix',
  'yanhuang1-taximap': 'taxismap',
  'yanhuang3-taoVolt': 'taovolt',
  'yanhuang4-malasoftware': 'malasoftware',
  'yanhuang6-ostable': 'osstable',
  'yanhuang12-buminiaga': 'buminiaga',
  'yanhuang10-tao-source': 'taosource',
  'yanhuang16-avants': 'avants',
  // 短名（兼容旧缓存）
  'yanhuang11': 'skymora',
  'yanhuang14': 'dldata',
  'yanhuang2': 'malatrading',
  'yanhuang19': 'zyronix',
  'yanhuang1': 'taxismap',
  'yanhuang3': 'taovolt',
  'yanhuang4': 'malasoftware',
  'yanhuang6': 'osstable',
  'yanhuang12': 'buminiaga',
  'yanhuang10': 'taosource',
  'yanhuang16': 'avants',
};

// 从 payer 名解析公司 key（兼容大小写、短名、后缀变化）
export function companyFromPayer(payer: string): string | null {
  if (!payer) return null;
  if (PAYER_TO_COMPANY[payer]) return PAYER_TO_COMPANY[payer];
  // 提取 yanhuangXX 前缀部分匹配
  const prefixMatch = payer.match(/^(yanhuang\d+)/i);
  if (prefixMatch && PAYER_TO_COMPANY[prefixMatch[1]]) return PAYER_TO_COMPANY[prefixMatch[1]];
  // 尝试从 "yanhuangXX-公司" 提取公司部分匹配（兼容编号变化、公司名不变的情况）
  //
  // 这里必须做「公司部分完全相等」的比较，不能用 endsWith：
  // endsWith 会让单字符后缀命中短名 key —— 例如 payer "webby-2" 的后缀 "2"
  // 能 endsWith 上 key "yanhuang2"，"GDX-1" 的 "1" 能 endsWith 上 "yanhuang11"，
  // 结果是**静默生成挂着别家公司资料的提额文档**，比识别失败危险得多。
  // 宁可返回 null，让前端弹出公司挑选由人来定。
  const suffix = payer.split('-').slice(1).join('-').toLowerCase();
  if (!suffix) return null;
  for (const [k, v] of Object.entries(PAYER_TO_COMPANY)) {
    const keySuffix = k.split('-').slice(1).join('-').toLowerCase();
    if (keySuffix && keySuffix === suffix) return v;
  }
  return null;
}

// 配额类型映射：service_code + quota 关键词 → AWS 官方 Quota Name + 文档类型
export interface QuotaTypeInfo {
  serviceLabel: string;     // 文档里的 Service 列（如 "Amazon EC2"）
  quotaName: string;        // 官方 Quota Name
  unit: string;             // 资源单位（vCPUs / EIPs / Instances / Hosts）
  category: 'vcpu' | 'eip' | 'lightsail' | 'mac' | 'workspace' | 'fargate' | 'other';
}

// 区域代码 → 显示名
export const REGION_DISPLAY: Record<string, string> = {
  'us-east-1': 'N. Virginia (us-east-1)',
  'us-east-2': 'Ohio (us-east-2)',
  'us-west-1': 'N. California (us-west-1)',
  'us-west-2': 'Oregon (us-west-2)',
  'eu-west-1': 'Ireland (eu-west-1)',
  'eu-west-2': 'London (eu-west-2)',
  'eu-west-3': 'Paris (eu-west-3)',
  'eu-north-1': 'Stockholm (eu-north-1)',
  'eu-central-1': 'Frankfurt (eu-central-1)',
  'eu-central-2': 'Zurich (eu-central-2)',
  'ap-southeast-1': 'Singapore (ap-southeast-1)',
  'ap-southeast-2': 'Sydney (ap-southeast-2)',
  'ap-southeast-3': 'Jakarta (ap-southeast-3)',
  'ap-southeast-5': 'Malaysia (ap-southeast-5)',
  'ap-northeast-1': 'Tokyo (ap-northeast-1)',
  'ap-northeast-2': 'Seoul (ap-northeast-2)',
  'ap-northeast-3': 'Osaka (ap-northeast-3)',
  'ap-south-1': 'Mumbai (ap-south-1)',
  'ap-east-1': 'Hong Kong (ap-east-1)',
  'ap-east-2': 'Taipei (ap-east-2)',
  'sa-east-1': 'São Paulo (sa-east-1)',
  'ca-central-1': 'Canada (ca-central-1)',
};

export function getRegionDisplay(region: string): string {
  return REGION_DISPLAY[region] || region;
}
