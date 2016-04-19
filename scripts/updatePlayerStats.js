'use strict';

const _ = require('lodash');
const co = require('co');
const config = require('config');
const distributions = require('distributions');
const math = require('mathjs');

var database = require('../database');

function calculatePredictionInterval(samples) {
    const ONE_DEVIATION_LOWER_BOUND = 0.16;
    const ONE_DEVIATION_UPPER_BOUND = 0.84;

    let n = _.size(samples);

    if (n > 1) {
        let mean = math.mean(samples);
        let deviation = math.std(samples);

        let distribution = new distributions.Studentt(n - 1);

        let low = mean + (distribution.inv(ONE_DEVIATION_LOWER_BOUND) * deviation * math.sqrt(1 + (1 / n)));
        let high = mean + (distribution.inv(ONE_DEVIATION_UPPER_BOUND) * deviation * math.sqrt(1 + (1 / n)));

        return {
            low,
            center: mean,
            high
        };
    }
    else if (n === 1) {
        let mean = math.mean(samples);

        return {
            low: null,
            center: mean,
            high: null
        };
    }
    else {
        return {
            low: null,
            center: null,
            high: null
        };
    }
}

function getDocumentID(info) {
    if (_.hasIn(info, 'toHexString')) {
        return info.toHexString();
    }

    if (_.isString(info)) {
        return info;
    }

    if (_.isObject(info)) {
        if (_.hasIn(info, '_id') && _.hasIn(info._id, 'toHexString')) {
            return info._id.toHexString();
        }

        if (_.hasIn(info, 'id')) {
            return info.id;
        }
    }

    return null;
}

function getGameUserInfo(game, user) {
    let userID = getDocumentID(user);

    let team;
    let role;
    let player;

    team = _.find(game.teams, function(currentTeam) {
        role = _.find(currentTeam.composition, function(currentRole) {
            player = _.find(currentRole.players, function(currentPlayer) {
                return userID === getDocumentID(currentPlayer.user);
            });

            if (player) {
                return true;
            }

            return false;
        });

        if (role || userID === getDocumentID(currentTeam.captain)) {
            return true;
        }

        return false;
    });

    if (team) {
        return {
            game,
            team,
            role,
            player
        };
    }

    return null;
}

co(function*() {
    const DRAFT_ORDER = config.get('app.draft.order');
    const ROLES = config.get('app.games.roles');

    let users = yield database.User.find({}, 'alias stats.rating').exec();

    for (let user of users) {
        let captainGames = yield database.Game.find({
            'teams.captain': getDocumentID(user),
            'status': 'completed',
            'score': {
                $exists: true
            }
        });

        let captainScores = _.map(captainGames, function(game) {
            let teamIndex = _.findIndex(game.teams, function(team) {
                return getDocumentID(team.captain) === getDocumentID(user);
            });

            let differential = 0;

            if (teamIndex === 0) {
                differential = (game.score[0] - game.score[1]) / 5;
            }
            else if (teamIndex === 1) {
                differential = (game.score[1] - game.score[0]) / 5;
            }

            let duration = game.duration ? game.duration / 1800 : 1;

            return differential / duration;
        });

        user.stats.captainScore = calculatePredictionInterval(captainScores);

        let playerGames = yield database.Game.find({
            'teams.composition.players.user': getDocumentID(user),
            'status': 'completed',
            'score': {
                $exists: true
            }
        });

        let playerScores = _.map(playerGames, function(game) {
            let gameUserInfo = getGameUserInfo(game, user);
            let teamIndex = _.indexOf(game.teams, gameUserInfo.team);

            let differential = 0;

            if (teamIndex === 0) {
                differential = (game.score[0] - game.score[1]) / 5;
            }
            else if (teamIndex === 1) {
                differential = (game.score[1] - game.score[0]) / 5;
            }

            let duration = game.duration ? game.duration / 1800 : 1;

            return differential / duration;
        });

        user.stats.playerScore = calculatePredictionInterval(playerScores);

        let draftStats = [];

        let captainGameCount = yield database.Game.count({
            'teams.captain': getDocumentID(user)
        }).count().exec();
        draftStats.push({
            type: 'captain',
            count: captainGameCount
        });

        let draftPositions = {};

        let playersPicked = _(DRAFT_ORDER).filter(function(turn) {
            return turn.type === 'playerPick';
        }).size();
        for (let i = 1; i <= playersPicked; i++) {
            draftPositions[i] = 0;
        }

        let draftedGames = yield database.Game.find({
            'draft.choices': {
                $elemMatch: {
                    'type': 'playerPick',
                    'player': getDocumentID(user)
                }
            }
        }).exec();
        for (let game of draftedGames) {
            let position = 0;

            for (let choice of game.draft.choices) {
                if (choice.type === 'playerPick') {
                    position++;

                    if (getDocumentID(choice.player) === getDocumentID(user)) {
                        break;
                    }
                }
            }

            if (!draftPositions[position]) {
                draftPositions[position] = 0;
            }
            draftPositions[position]++;
        }

        _.each(draftPositions, function(count, position) {
            draftStats.push({
                type: 'picked',
                position,
                count
            });
        });

        let undraftedCount = yield database.Game.find({
            $nor: [{
                'draft.choices': {
                    $elemMatch: {
                        'type': 'playerPick',
                        'player': getDocumentID(user)
                    }
                }
            }, {
                'teams.captain': getDocumentID(user)
            }],
            'draft.pool.players.user': getDocumentID(user)
        }).count().exec();
        draftStats.push({
            type: 'undrafted',
            count: undraftedCount
        });

        user.stats.draft = draftStats;

        let rating = yield database.Rating.findOne({
            user: getDocumentID(user)
        }).sort('-date').exec();

        if (rating) {
            user.stats.rating.mean = rating.after.mean;
            user.stats.rating.deviation = rating.after.deviation;
        }

        user.stats.roles = yield _(ROLES).keys().map(role => database.Game.find({
            'teams.composition': {
                $elemMatch: {
                    'role': role,
                    'players.user': getDocumentID(user)
                }
            }
        }).count().exec().then(count => ({
            role,
            count
        }))).value();

        user.stats.total.captain = yield database.Game.count({
            'teams.captain': getDocumentID(user)
        }).count().exec();
        user.stats.total.player = yield database.Game.count({
            'teams.composition.players.user': getDocumentID(user)
        }).count().exec();

        yield user.save();
    }

    process.exit(0);
});