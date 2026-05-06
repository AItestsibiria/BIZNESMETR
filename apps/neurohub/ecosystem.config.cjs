module.exports = {
  apps: [{
    name: 'neurohub',
    script: '/var/www/neurohub/dist/index.cjs',
    cwd: '/var/www/neurohub',
    env: {
      NODE_ENV: 'production',
      PORT: '4000'
    }
  }]
};
