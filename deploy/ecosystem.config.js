// PM2 ecosystem config — production
module.exports = {
  apps: [{
    name: 'paymob-ghl',
    script: 'src/index.js',
    instances: 1,           // single instance (cron job is in-process)
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
    },
    // Restart policies
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 5000,
    // Logs
    out_file: '/var/log/paymob-ghl/out.log',
    error_file: '/var/log/paymob-ghl/error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    // Graceful shutdown
    kill_timeout: 10000,
    listen_timeout: 8000,
    shutdown_with_message: true,
  }],
};
