#!/bin/bash
# HTTPS setup for AWS Toolbox
# Usage: sudo ./setup-nginx.sh yourdomain.com

DOMAIN=${1:-"toolbox.example.com"}

echo "Setting up HTTPS for $DOMAIN"

# Install nginx + certbot
sudo yum install -y nginx certbot python3-certbot-nginx 2>/dev/null || sudo apt install -y nginx certbot python3-certbot-nginx

# Nginx config
sudo tee /etc/nginx/conf.d/aws-toolbox.conf > /dev/null <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;

        # 后台 job 控制 API 都是短请求；下载 zip 时允许较长的流式传输窗口。
        proxy_read_timeout 10m;
        proxy_send_timeout 10m;
        send_timeout 10m;
    }
}
EOF

# Start nginx
sudo systemctl start nginx
sudo systemctl enable nginx

# Get SSL cert
sudo certbot --nginx -d $DOMAIN --non-interactive --agree-tos --email admin@$DOMAIN

# Auto-renew cron
echo "0 0 * * * certbot renew --quiet" | sudo crontab -

echo "✅ HTTPS configured for https://$DOMAIN"
echo "   Make sure DNS points $DOMAIN to this server's IP"
