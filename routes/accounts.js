'use strict';

const express = require('express');
const router = express.Router();
const passport = require('passport');
const validator = require('validator');
const Promise = require('bluebird');
const _ = require('lodash');
const db = require('../models/database');
const Account = require('../models/accounts');
const UserAccountRole = require('../models/userAccountRoles');
const AccountInvitations = require('../models/accountInvitations');
const ERRORS = require('./errors');

const userWithRoles = function(qb) {
  qb.column([
    'users.firstName',
    'users.lastName',
    'users.id',
    db.knex.raw('array_agg(roles.id) AS role_ids, array_agg(roles.name) AS role_names')
  ]);
  qb.innerJoin('roles','xref_user_account_roles.role_id','roles.id');
  qb.groupBy('users.id','users.firstName','users.lastName','xref_user_account_roles.user_id','xref_user_account_roles.account_id');
};

const isSiteAdmin = function(req, res, next) {
  if(!req.userIs('siteAdmin')) {
    return next(ERRORS.NOT_AUTHORIZED);
  }
  next();
};
const isSuperuserOrAdmin = function(req, res, next) {
  if(!req.userIs('superuser') || !req.userIs('account admin')) {
    return next(ERRORS.NOT_AUTHORIZED);
  }
  next();
};
const userIsAccountAdmin = function(user, account) {
  if(!account.users || !_.isArray(account.users)) return false;
  let matchedUser = _.find(account.users, {id: user.id});
  if(matchedUser === null) return false;
  return matchedUser.role_ids.indexOf(1) !== -1;
};

const userCanEditAccountByAccountId = function(user, accountId, next) {
  //fetch the account to check user access
  Account
    .where({id: accountId})
    .fetch({
      withRelated: [{'users':userWithRoles}]
    })
    .then(function(account) {
      //serialize
      if(!account) {
        return next(ERRORS.NOT_AUTHORIZED);
      }
      account = account.serialize({shallow: false});
      if(!userIsAccountAdmin(user, account)) {
        return next(ERRORS.NOT_AUTHORIZED);
      }
      next();
    });
};


/* GET accounts listing. */
router.route('/')
  .get(
    passport.authenticate('jwt', { failWithError: true, session: false }),
    function(req, res, next) {
      let accounts;
      if(req.userIs('siteAdmin')) {
        Account
          .fetchAll()
          .then(function (accounts) {
            res.json(accounts);
          })
      } else {
        //if not superuser or site admin, only allow someone with "account admin"=1 level access
        Account
          .query(function(qb) {
            qb.where('xref_user_account_roles.user_id','=',req.user.id)
              .andWhere('xref_user_account_roles.role_id','=',1)
              .innerJoin('xref_user_account_roles','xref_user_account_roles.account_id','accounts.id')
              .groupBy('accounts.id')
          })
          .fetchAll()
          .then(function (accounts) {
            res.json(accounts);
          })
      }
    }
  )
  .post(
    passport.authenticate('jwt', { failWithError: true, session: false }),
    isSiteAdmin,
    function (req, res, next) {
    let data = _.pick(req.body, ['name', 'description']);
    Account.forge({
      name: data.name,
      description: data.description
    })
      .save(null, {method: 'insert'})
      .then(function(account) {
        res.json(account);
      })
      .catch(function(err) {
        next(err);
      });
  });

/* Single Account */
router.route('/:id')
  .get(
    passport.authenticate('jwt', { failWithError: true, session: false }),
    function(req, res, next) {
      //fetch the user by id
      Account
        .where({id: req.params.id})
        .fetch({
          withRelated: [{'users':userWithRoles}, 'invitations']
        })
        .then(function(account) {
          //serialize
          if(!account) {
            return next(null, false);
          }
          account = account.serialize({shallow: false});

          if(req.userIs('siteAdmin') || userIsAccountAdmin(req.user, account)) {
            res.json(account);
          } else {
            return next(ERRORS.NOT_AUTHORIZED);
          }
        })
        .catch(function(err) {
          next(err);
        });
    })
  .put(
    passport.authenticate('jwt', { failWithError: true, session: false }),
    function(req, res, next) {
      if(req.userIs('siteAdmin')) {
        return next();
      }
      userCanEditAccountByAccountId(req.user, req.params.id, next);
    },
    function(req, res, next) {
      let params = _.pick(req.body, ['name', 'description', 'enabled', 'users']);

      // only allow updates that lack a user object (and don't update users at all), or provides an array of user objects
      if(params.users && (!_.isArray(params.users) ||  params.users.length === 0)) {
        return next(ERRORS.ACCOUNT_UPDATE_REQUIRES_USERS)
      }
      if(!params.users) params.users = [];

      // validate the updating user objects
      let err = null;
      params.users = params.users.map(function(user) {
        if((!user.id && !user.user_id) || (!user.role_id && !user.role_ids)) {
          err = ERRORS.ACCOUNT_UPDATE_USER_DATA_VALIDATION;
        }

        if(user.role_ids) {
          let userRoles = [];
          user.role_ids.forEach(function(role_id) {
            userRoles.push({
              'user_id': (user.id) ? user.id : user.user_id,
              'role_id': role_id
            });
          });
          return userRoles;
        }
        return {
          'user_id': (user.id) ? user.id : user.user_id,
          'role_id': user.role_id
        }
      });
      params.users = _.flatten(params.users);

      if(err) next(err);

      //In this transaction, we delete all account/user pairs and recreate them, unless params.users is unset
      db.transaction(function(t) {
        return new Account({
          id: req.params.id
        })
        .save({
          name        : params.name,
          description : params.description,
          enabled     : params.enabled
        },{
          transacting: t,
          method: 'update',
          require: true
        })
        .tap(function(model) {
          if(params.users.length === 0) return true;
          return UserAccountRole
            .where({'account_id': model.id})
            .destroy({require: false, transacting: t});
        })
        .tap(function(model) {
          if(params.users.length === 0) return true;
          return Promise.map(params.users, function(data) {
            return new UserAccountRole(data).save({'account_id': model.id}, {method: 'insert', require: false, transacting: t});
          });
        });
      }).then(function(account) {
        if(!account) {
          return next(null, false);
        }
        account.load([{'users':userWithRoles}]).then(function(account) {
          if(!account) {
            return next(null, false);
          }
          res.json(account);
        }).catch(function(err) {
          next(err);
        })

      }).catch(function(err) {
        next(err);
      });
    }
  )
  .delete(
    passport.authenticate('jwt', { failWithError: true, session: false }),
    isSiteAdmin,
    function(req, res, next) {
    return Account
      .where({id: req.params.id})
      .destroy()
      .then(function(user) {
        res.json({'message': 'Account successfully deleted'});
      }).catch(function(err) {
        next(err);
      })
    }
  );

router.route('/:id/invitations')
  .post(
    passport.authenticate('jwt', { failWithError: true, session: false }),
    function(req, res, next) {
      if(req.userIs('siteAdmin')) {
        return next();
      }
      userCanEditAccountByAccountId(req.user, req.params.id, next);
    },
    function(req, res, next) {
    let params = _.pick(req.body, ['email', 'role_ids']);
    params.id = req.params.id;
    if(!validator.isEmail(params.email)) {
      return next(ERRORS.INVITATION_INVALID_EMAIL);
    }
    if(!_.isArray(params.role_ids) || params.role_ids.length === 0) {
      return next(ERRORS.INVITATION_NO_ROLES_PROVIDED);
    }

    let saveAccount = AccountInvitations.forge({
        account_id: params.id,
        email: params.email,
        invited_role_ids: params.role_ids
      }).save();

    let loadInvitation = saveAccount.then(function(invitation) {
      if(!invitation) return Promise.reject('Invitation not created.');
      return invitation.refresh();
    });

    return loadInvitation.then(function(invitation) {
      if(!invitation) {
        return next(null, false);
      }
      res.json(invitation);
    }).catch(function(err) {
      return next(err);
    })

  });

module.exports = router;
