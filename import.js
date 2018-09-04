/**
 * import
 */

/* Node modules */
const fs = require('fs');

/* Third-party modules */
const mailgun = require('nodemailer-mailgun-transport');
const ms = require('ms');
const nodemailer = require('nodemailer');
const request = require('request-promise-native');

/* Files */

const config = {
  faas: {
    username: secretOrEnvvar('/run/secrets/cron-starling-faas-username', 'FAAS_USERNAME'),
    password: secretOrEnvvar('/run/secrets/cron-starling-faas-password', 'FAAS_PASSWORD'),
    url: process.env.FAAS_URL
  },
  freeagent: {
    accountId: secretOrEnvvar('/run/secrets/cron-starling-freeagent-account-id', 'FREEAGENT_ACCOUNT_ID'),
    token: secretOrEnvvar('/run/secrets/cron-starling-freeagent-token', 'FREEAGENT_TOKEN'),
  },
  mailgun: {
    domain: secretOrEnvvar('/run/secrets/cron-starling-mailgun-domain', 'MAILGUN_DOMAIN'),
    key: secretOrEnvvar('/run/secrets/cron-starling-mailgun-key', 'MAILGUN_KEY')
  },
  notify: {
    from: secretOrEnvvar('/run/secrets/cron-starling-notify-from', 'NOTIFY_FROM'),
    snitch: secretOrEnvvar('/run/secrets/cron-starling-snitch-url', 'CRON_SNITCH'),
    subject: process.env.NOTIFY_SUBJECT,
    to: secretOrEnvvar('/run/secrets/cron-starling-notify-to', 'NOTIFY_TO')
  },
  starling: {
    from: process.env.STARLING_FROM || '-7 days',
    token: process.env.STARLING_TOKEN
  },
};

function callSnitch () {
  if (!config.notify.snitch) {
    /* Do nothing */
    return Promise.resolve();
  }

  logger('Calling Dead Man\'s Snitch', {
    url: config.notify.snitch
  });

  return request.get(config.notify.snitch)
    .catch((err) => {
      logger('Error calling Dead Man\'s Snitch', {
        err: err.stack,
        url: config.notify.snitch
      });
    });
}

const emailer = nodemailer.createTransport(mailgun({
  auth: {
    api_key: config.mailgun.key,
    domain: config.mailgun.domain
  }
}));

function faasRequest (opts) {
  const defaultOpts = {
    baseUrl: `${config.faas.url}/function`,
    method: 'POST',
    json: true
  };

  if (config.faas.username && config.faas.password) {
    defaultOpts.auth = {
      username: config.faas.username,
      password: config.faas.password
    };
  }

  return request.defaults(defaultOpts)(opts);
}

function logger (message, data = {}) {
  console.log(JSON.stringify({
    message,
    data
  }));
}

function notifyUser (subject, text) {
  logger('Notifying user', {
    subject,
    text
  });

  return new Promise((resolve, reject) => {
    emailer.sendMail({
      from: config.notify.from,
      to: config.notify.to,
      subject: `${config.notify.subject}${subject}`,
      text
    }, (err, info) => {
      if (err) {
        logger('Error notifying user', {
          err,
          subject,
          text
        });

        reject(err);
        return;
      }

      logger('User notified successfully', {
        info,
        subject,
        text
      });

      resolve(info);
    });
  });
}

function secretOrEnvvar (secretFile, envvar) {
  let value;
  try {
    value = fs.readFileSync(secretFile, 'utf8');
  } catch (err) {
    value = process.env[envvar];
  }

  return value;
}

const startDate = Date.now();

Promise.resolve()
  .then(() => callSnitch())
  .then(() => {
    /* Get the list of transactions */
    const fromDate = new Date(Date.now() + ms(config.starling.from));

    logger('Looking for transactions from date', {
      fromDate,
    });

    return faasRequest({
      url: 'func_starling',
      body: {
        method: 'getTransactions',
        refreshToken: config.starling.token,
        args: [{
          from: fromDate,
        }],
      },
    });
  })
  .then(({ transactions }) => {
    const data = transactions.map(transaction => ({
      date: new Date(transaction.created),
      amount: transaction.amount,
      description: transaction.narrative,
    }));

    logger('Retrieved transactions and uploading to FreeAgent', {
      count: data.length,
    });

    return faasRequest({
      url: 'func_freeagent',
      body: {
        method: 'uploadBankStatement',
        refreshToken: config.freeagent.token,
        args: [
          config.freeagent.accountId,
          data,
        ],
      },
    });
  })
  .then(() => {
    logger('Successfully uploaded transactions to FreeAgent');
  })
  .catch(err => notifyUser('Error uploading transactions', err.stack))
  .then(() => {
    logger('Cronjob finished', {
      executionTime: Date.now() - startDate,
    });
  });
