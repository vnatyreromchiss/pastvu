import fs from 'fs';
import ms from 'ms';
import _ from 'lodash';
import path from 'path';
import step from 'step';
import jade from 'jade';
import log4js from 'log4js';
import moment from 'moment';
import config from '../config';
import Utils from '../commons/Utils';
import * as session from './_session';
import { send as sendMail } from './mail';
import { userSettingsDef } from './settings';
import { getRegionsArrFromCache } from './region';

import { User, UserConfirm } from '../models/User';
import { Counter } from '../models/Counter';

moment.locale(config.lang);

const ms2d = ms('2d');
const human2d = moment.duration(ms2d).humanize();

const logger = log4js.getLogger('auth.js');
const preaddrs = config.client.subdomains.map(function (sub) {
    return `${sub}.${config.client.host}`;
});
const msg = {
    deny: 'You do not have permission for this action',
    regError: 'Ошибка регистрации'
};

let recallTpl;
let regTpl;

// Users login
async function login(socket, { login, pass } = {}) {
    if (!login) {
        throw { message: 'Fill in the login field' };
    }
    if (!pass) {
        throw { message: 'Fill in the password field' };
    }

    try {
        const user = await User.getAuthenticated(login, pass);

        // Pass user to session
        const { userPlain } = await session.loginUser(socket, user);

        return { message: 'Success login', youAre: userPlain };
    } catch (err) {
        switch (err.code) {
            case User.failedLogin.NOT_FOUND:
            case User.failedLogin.PASSWORD_INCORRECT:
                // note: these cases are usually treated the same - don't tell the user *why* the login failed, only that it did
                throw { message: 'Неправильная пара логин-пароль' };
            case User.failedLogin.MAX_ATTEMPTS:
                // send email or otherwise notify user that account is temporarily locked
                throw {
                    message: 'Your account has been temporarily locked due to exceeding the number of wrong login attempts'
                };
            default:
                logger.error('Auth login session.loginUser: ', err);
                throw { message: 'Ошибка авторизации' };
        }
    }
}

// Users logout
async function logout(socket) {
    await session.logoutUser(socket);

    return {};
};

// Registration
async function register(iAm, { login, email, pass, pass2 }) {
    if (!login) {
        throw { message: 'Заполните имя пользователя' };
    }

    if (login !== 'anonymous' &&
        !login.match(/^[\.\w-]{3,15}$/i) || !login.match(/^[A-za-z].*$/i) || !login.match(/^.*\w$/i)) {
        throw {
            message: 'Имя пользователя должно содержать от 3 до 15 латинских символов и начинаться с буквы. ' +
            'В состав слова могут входить цифры, точка, подчеркивание и тире'
        };
    }

    if (!email) {
        throw { message: 'Fill in the e-mail field' };
    }

    email = email.toLowerCase();

    if (!pass) {
        throw { message: 'Fill in the password field' };
    }
    if (pass !== pass2) {
        throw { message: 'Пароли не совпадают' };
    }

    let user = await User.findOne({ $or: [{ login: new RegExp('^' + login + '$', 'i') }, { email }] }).exec();

    if (user) {
        if (user.login.toLowerCase() === login.toLowerCase()) {
            throw { message: 'Пользователь с таким именем уже зарегистрирован' };
        }
        if (user.email === email) {
            throw { message: 'Пользователь с таким email уже зарегистрирован' };
        }

        throw { message: 'Пользователь уже зарегистрирован' };
    }

    const count = await Counter.increment('user');

    let regionHome = getRegionsArrFromCache([config.regionHome]);

    if (regionHome.length) {
        regionHome = regionHome[0]._id;
    }

    user = new User({
        pass,
        email,
        login,
        cid: count.next,
        disp: login,
        regionHome: regionHome || undefined, // Take home default home region from config
        settings: {
            // Empty settings objects will not be saved, so fill it with one of settings
            subscr_auto_reply: userSettingsDef.subscr_auto_reply || true
        }
    });

    await user.save();

    try {
        const confirmKey = Utils.randomString(7);

        await new UserConfirm({ key: confirmKey, user: user._id }).save();

        sendMail({
            sender: 'noreply',
            receiver: { alias: login, email },
            subject: 'Подтверждение регистрации',
            head: true,
            body: regTpl({
                email,
                login,
                config,
                confirmKey,
                username: login,
                greeting: 'Спасибо за регистрацию на проекте PastVu!',
                linkvalid: `${human2d} (до ${moment.utc().add(ms2d).format('LLL')})`
            }),
            text: `Перейдите по следующей ссылке: ${config.client.origin}/confirm/${confirmKey}`
        });

    } catch (err) {
        await User.remove({ login });

        logger.error('Auth register after save: ', err);
        throw { message: msg.regError };
    }

    return {
        message: 'Учетная запись создана успешно. Для завершения регистрации следуйте инструкциям, ' +
        'отправленным на указанный вами e-mail'
    };
}

// Отправка на почту запроса на восстановление пароля
var successPublic = { message: 'Запрос успешно отправлен. Для продолжения процедуры следуйте инструкциям, высланным на Ваш e-mail' }, //success = 'The data is successfully sent. To restore password, follow the instructions sent to Your e-mail',
    recallPublicError = { message: 'Ошибка восстановления пароля', error: true };
function recall(iAm, data, cb) {
    var confirmKey = '';

    if (!_.isObject(data) || !data.login) {
        return cb({ message: 'Bad params', error: true });
    }

    step(
        function checkUserExists() {
            User.findOne({
                $or: [
                    { login: new RegExp('^' + data.login + '$', 'i') },
                    { email: data.login.toLowerCase() }
                ]
            }).exec(this);
        },
        function (err, user) {
            if (err) {
                logger.error('Auth recall User.findOne: ', err);
                return cb(recallPublicError);
            }
            if (!user) {
                return cb({ message: 'Пользователя с таким логином или e-mail не существует', error: true }); //'User with such login or e-mail does not exist'
            }
            // Если залогинен и пытается восстановить не свой аккаунт, то проверяем что это админ
            if (iAm.registered && iAm.user.login !== data.login && !iAm.isAdmin) {
                return cb({ message: msg.deny, error: true });
            }

            data._id = user._id;
            data.login = user.login;
            data.email = user.email;
            data.disp = user.disp;
            confirmKey = Utils.randomString(8);
            UserConfirm.remove({ user: user._id }, this);
        },
        function (err) {
            if (err) {
                logger.error('Auth recall UserConfirm.remove: ', err);
                return cb(recallPublicError);
            }
            new UserConfirm({ key: confirmKey, user: data._id }).save(this);
        },
        function finish(err) {
            if (err) {
                logger.error('Auth recall UserConfirm.save: ', err);
                return cb(recallPublicError);
            }
            cb(successPublic);

            sendMail({
                sender: 'noreply',
                receiver: { alias: data.login, email: data.email },
                subject: 'Запрос на восстановление пароля',
                head: true,
                body: recallTpl({
                    data,
                    config,
                    confirmKey,
                    username: data.disp,
                    linkvalid: `${human2d} (до ${moment.utc().add(ms2d).format('LLL')})`
                }),
                text: `Перейдите по следующей ссылке: ${config.client.origin}/confirm/${confirmKey}`
            });
        }
    );
}

// Смена пароля по запросу восстановлния из почты
var passChangeRecallPublicError = { message: 'Ошибка смены пароля', error: true };
function passChangeRecall(iAm, data, cb) {
    var error = '',
        key = data.key;

    if (!data || !Utils.isType('string', key) || key.length !== 8) {
        error = 'Bad params. ';
    }
    if (!data.pass) {
        error += 'Fill in the password field. ';
    }
    if (data.pass !== data.pass2) {
        error += 'Passwords do not match.';
    }
    if (error) {
        return cb({ message: error, error: true });
    }

    UserConfirm.findOne({ key }).populate('user').exec(function (err, confirm) {
        if (err) {
            logger.error('Auth passChangeRecall UserConfirm.findOne: ', err);
            return cb(passChangeRecallPublicError);
        }
        if (!confirm || !confirm.user) {
            return cb(passChangeRecallPublicError);
        }
        step(
            function () {
                // Если залогиненный пользователь запрашивает восстановление, то пароль надо поменять в модели пользователя сессии
                // Если аноним - то в модели пользователи конфирма
                // (Это один и тот же пользователь, просто разные объекты)
                var user = iAm.registered && iAm.user.login === confirm.user.login ? iAm.user : confirm.user;
                user.pass = data.pass;

                // Если неактивный пользователь восстанавливает пароль - активируем его
                if (!user.active) {
                    user.active = true;
                    user.activatedate = new Date();
                }

                user.save(this.parallel());
                confirm.remove(this.parallel());
            },
            function (err) {
                if (err) {
                    logger.error('Auth passChangeRecall user.save or confirm.remove: ', err);
                    return cb(passChangeRecallPublicError);
                }

                cb({ message: 'Новый пароль сохранен успешно' });
            }
        );
    });
}

// Смена пароля в настройках пользователя с указанием текущего пароля
var passChangePublicError = { message: 'Ошибка смены пароля', error: true };
function passChange(iAm, data, cb) {
    var error = '';

    if (!iAm.registered || !data || iAm.user.login !== data.login) {
        return cb({ message: 'Вы не авторизованны для этой операции', error: true }); // 'You are not authorized for this action'
    }
    if (!data.pass || !data.passNew || !data.passNew2) {
        error += 'Заполните все поля. '; // 'Fill in all password fields. ';
    }
    if (data.passNew !== data.passNew2) {
        error += 'Новые пароли не совпадают. '; // 'New passwords do not match each other.';
    }
    if (error) {
        return cb({ message: error, error: true });
    }

    iAm.user.checkPass(data.pass, function (err, isMatch) {
        if (err) {
            logger.error('Auth passChange iAm.user.checkPass: ', err);
            return cb(passChangePublicError);
        }

        if (isMatch) {
            iAm.user.pass = data.passNew;
            iAm.user.save(function (err) {
                if (err) {
                    logger.error('Auth passChange iAm.user.save: ', err);
                    return cb(passChangePublicError);
                }
                cb({ message: 'Новый пароль установлен успешно' }); //'Password was changed successfully!'
            });
        } else {
            cb({ message: 'Текущий пароль не верен', error: true }); //'Current password incorrect'
        }
    });
}

//Проверка ключа confirm
var checkConfirmPublicError = { message: 'Ошибка подтверждения ключа', error: true };
function checkConfirm(data, cb) {
    if (!data || !Utils.isType('string', data.key) || data.key.length < 7 || data.key.length > 8) {
        cb({ message: 'Bad params', error: true });
        return;
    }

    var key = data.key;
    UserConfirm.findOne({ key: key }).populate('user').exec(function (err, confirm) {
        if (err) {
            logger.error('Auth checkConfirm UserConfirm.findOne: ', err);
            return cb(checkConfirmPublicError);
        }
        if (!confirm || !confirm.user) {
            return cb({ message: 'Переданного вами ключа не существует', error: true });
        }
        var user = confirm.user,
            avatar;

        if (key.length === 7) { //Confirm registration
            step(
                function () {
                    user.active = true;
                    user.activatedate = new Date();
                    user.save(this.parallel());
                    confirm.remove(this.parallel());
                },
                function (err) {
                    if (err) {
                        logger.error('Auth checkConfirm confirm.remove: ', err);
                        return cb(checkConfirmPublicError);
                    }

                    cb({
                        message: 'Спасибо, регистрация подтверждена! Теперь вы можете войти в систему, используя ваш логин и пароль',
                        type: 'noty'
                    });
                    //cb({message: 'Thank you! Your registration is confirmed. Now you can enter using your username and password', type: 'noty'});
                }
            );
        } else if (key.length === 8) { //Confirm pass change
            if (user.avatar) {
                if (preaddrs.length) {
                    avatar = preaddrs[0] + '/_a/h/' + user.avatar;
                } else {
                    avatar = '/_a/h/' + user.avatar;
                }
            } else {
                avatar = '/img/caps/avatarth.png';
            }
            cb({ message: 'Pass change', type: 'authPassChange', login: user.login, disp: user.disp, avatar: avatar });
        }

    });
}

export const ready = new Promise(async function(resolve, reject) {
    try {
        const [regData, recallData] = await* [
            fs.readFileAsync(path.normalize('./views/mail/registration.jade'), 'utf-8'),
            fs.readFileAsync(path.normalize('./views/mail/recall.jade'), 'utf-8')
        ];

        regTpl = jade.compile(regData, { filename: path.normalize('./views/mail/registration.jade'), pretty: false });
        recallTpl = jade.compile(recallData, { filename: path.normalize('./views/mail/recall.jade'), pretty: false });
        resolve();
    } catch (err) {
        err.message = 'Auth jade read error: ' + err.message;
        reject(err);
    }
});

export function loadController(io) {
    io.sockets.on('connection', function (socket) {
        const hs = socket.handshake;

        socket.on('loginRequest', function (data) {
            login(socket, data)
                .catch(function (err) {
                    return { message: err.message, error: true };
                })
                .then(function (resultData) {
                    socket.emit('loginResult', resultData);
                });
        });

        socket.on('logoutRequest', function () {
            logout(socket)
                .catch(function (err) {
                    return { message: err.message, error: true };
                })
                .then(function (resultData) {
                    socket.emit('logouResult', resultData);
                });
        });

        socket.on('registerRequest', function (data) {
            register(hs.usObj, data)
                .catch(function (err) {
                    return { message: err.message, error: true };
                })
                .then(function (resultData) {
                    socket.emit('registerResult', resultData);
                });
        });

        socket.on('recallRequest', function (data) {
            recall(hs.usObj, data, function (data) {
                socket.emit('recallResult', data);
            });
        });

        socket.on('passChangeRecall', function (data) {
            passChangeRecall(hs.usObj, data, function (data) {
                socket.emit('passChangeRecallResult', data);
            });
        });
        socket.on('passChangeRequest', function (data) {
            passChange(hs.usObj, data, function (data) {
                socket.emit('passChangeResult', data);
            });
        });

        socket.on('whoAmI', function () {
            socket.emit('youAre', {
                user: hs.usObj.user && hs.usObj.user.toObject ? hs.usObj.user.toObject() : null,
                registered: hs.usObj.registered
            });
        });

        socket.on('checkConfirm', function (data) {
            checkConfirm(data, function (data) {
                socket.emit('checkConfirmResult', data);
            });
        });
    });
};