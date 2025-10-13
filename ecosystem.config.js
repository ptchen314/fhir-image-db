module.exports = {
  apps: [
    {
      name: 'fhir-image-db',
      script: 'sails lift',
      instances: 1,
      autorestart: true,
      watch: true,
      max_memory_restart: '1G',
    }
  ]
};

