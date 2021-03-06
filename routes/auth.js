'use strict';

const express = require('express');
const router = express.Router();
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const GoogleTokenStrategy = require('passport-google-id-token');
const jwt = require('jsonwebtoken');
const config = require('config');
const db = require('../models/database');
const Promise = require('bluebird');
const UserEmail = require('../models/userEmails');
const User = require('../models/users');
const UserAccountRole = require('../models/userAccountRoles');
const AccountInvitations = require('../models/accountInvitations');
const ERRORS = require('./errors');
const _ = require('lodash');
const CONSTANTS = require('../config/constants');

const validateUser = function (req, accessToken, refreshToken, profile, next) {
    // console.info('profile', profile);
    if (!profile || !profile.emails) {
        return Promise.reject();
    }
    let emails = profile.emails.map(function (email) {
        return email.value;
    });
    //TODO: if there are multiple emails in the profile, with different user-ids, merge down to a single user-id
    let lookupUserId = UserEmail.query().select('user_id').whereIn('email', emails).groupBy('user_id');
    let user = lookupUserId.then(function (results) {
        if (!results || results.length === 0) return Promise.reject(CONSTANTS.USER_NOT_FOUND);
        if (results.length > 1) {
            console.error('Emails match multiple user IDs');
        }
        let userId = results[0].user_id;
        return User.where({id: userId}).fetch();
    });
    return user;
};

const validationCallback = function (fn, req, accessToken, refreshToken, profile, next) {
    fn(req, accessToken, refreshToken, profile, next)
        .then(function (result) {
            // console.info('result', result);
            return next(null, result);
        })
        .catch(function (error) {
            // console.info('error', error);
            if (_.isString(error)) {
                var e = new Error(error);
                e.status = 400;
                return next(e);
            }
            return next(error);
        });
};

const validateUserCallback = function (req, accessToken, refreshToken, profile, next) {
    return validationCallback(validateUser, req, accessToken, refreshToken, profile, next);
};

const resolveUserJWT = function (req, res) {
    // console.info('resolveUserJWT', req, res);
    let user = req.user;
    let token = jwt.sign({id: user.id}, config.get('secret'), {
        expiresIn: '365d'
    });

    console.info('HOST: ' + req.get('Host'));
    console.info('HOSTNAME' + req.hostname);

//    let myDomain = req.get('Host');
    let myDomain = req.hostname;
    if (req.get('Host').startsWith('acmc')) {
        myDomain = myDomain.substring(4); //set cookie for entire Gaia environment domain instead of acmc subdomain
    }
    res.cookie('gaia.token', token, {
        httpOnly: true,
        domain: myDomain
    });
    res.json({success: true, user: user});
};

//passport setup
passport.use('google', new GoogleStrategy({
        clientID: config.get('authentication.googleStrategy.clientId'),
        clientSecret: config.get('authentication.googleStrategy.clientSecret'),
        callbackURL: config.get('authentication.googleStrategy.callbackURL'),
    },
    new function LogMyClientForEasierDebugging() {
        console.log('My Client ID is ' + config.get('authentication.googleStrategy.clientId').substring(0, 8))
    },
    validateUserCallback)
);

passport.use('google-id-token', new GoogleTokenStrategy({
        clientID: config.get('authentication.googleStrategy.clientId')
    },
    function (parsedToken, googleId, done) {
        let profile = _.clone(parsedToken.payload);
        profile.emails = [{value: profile.email}];
        profile.displayName = profile.name;
        return validateUserCallback(null, null, null, profile, done);
    })
);
//serialization is needed due to using passport.authenticate with custom callback for better logging
passport.serializeUser(function (user, done) {
    done(null, user);
});
passport.deserializeUser(function (user, done) {
    done(null, user);
});

/* GET users listing. */
router.get('/google',
    passport.authenticate('google', {
        scope: 'profile email',
        response_type: 'token'
    }));

router.get('/google/return',
    passport.authenticate('google', {
        session: false,
        failureRedirect: '/login',
        passReqToCallback: true,
    }), resolveUserJWT);


/*
 ========================= ORIGINAL WITH NO LOGGING =========================
 router.post('/google/token',
 passport.authenticate('google-id-token', {
 session: false,
 passReqToCallback: true
 }),
 resolveUserJWT);
 ========================= END OF ORIGINAL =========================
 */


router.post('/google/token', function (req, res, next) {
    passport.authenticate('google-id-token', {session: false, passReqToCallback: true}, function (err, user, info) {
        if (err) {
            //Examples: user authenticated by Google but not found in ACM DB or any other exception thrown
            console.error('Error occurred when trying to authenticate: ' + err.message + ' (status ' + err.status +')');
            return next(err);
        }
        if (!user) {
            //Examples: no connection to google OR bad client id OR 'google' GoogleStrategy is not defined well
            console.error('Authentication failure: ' + JSON.stringify(info));
            return res.redirect('/login');
        }
        req.logIn(user, function (err) {
            console.log('Logging in as ' + user.id);
            if (err) {
                console.error('Failed to login as ' + user.id + ' due to ' + JSON.stringify(err));
                return next(err);
            }
            console.log('Logged in as ' + user.id);
            next();
        });
    })(req, res, next)
}, resolveUserJWT);


router.get('/gaia.logout', function (req, res) {
    res.clearCookie('gaia.token', {
        httpOnly: true,
        domain: '.' + process.env.DOMAIN
    });
    res.json({success: true});
});


exports.router = router;
exports.validateUser = validateUser;
exports.CONSTANTS = CONSTANTS;
