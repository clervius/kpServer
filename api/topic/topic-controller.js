const Topic = require('./topic-model');
const { handleErr, returnObjectsArray } = require('../util/helpers');
const axios = require('axios');
const async = require('async');
const { has } = require('lodash');
const url = 'https://wordsapiv1.p.mashape.com/words/'
const headers = {
  'X-Mashape-Key': process.env.RAPID_API
}
const wordApi = word => axios.get(`${url}${word}`, { headers });

module.exports = {
  getOne: (req, res) => {
    const { id } = req.params;
    if (!id) {
      return handleErr(res, 400, 'Please try your request again. Missing :id property', false);
    }
    Topic.findById(id).exec().then(
      topic => !topic ? handleErr(res, 404,'Topic not found.', false) : res.json(topic),
      err => handleErr(res, 500, 'Error retriving topic.', err)
    );
  },
  getAll: (req, res) => {
    Topic.find().exec().then(
      topics => res.json(returnObjectsArray(topics)),
      err => handleErr(res, 500)
    );
  },
  search: (req, res) => {
    const { text } = req.query;
    if (!text) {
      return handleErr(res, 400, 'You must type something in to perform a search.', false);
    }
    const hit = new RegExp("^" + text, "i")
    const query = {
      $or: [
        { name: hit },
        { description: hit }
      ]
    };
    Topic.find(query).exec().then(
      topics => res.json(returnObjectsArray(topics)),
      err => handleErr(res, 501, 'Server error searching for your topics', err)
    )
  },
  add: (req, res) => {
    const { name, description } = req.body;
    const validate = done => {
      if (!name) {
        return done({
          status: 400,
          message: 'You must include a name for this topic.',
          data: name
        });
      };
      const newTopic = new Topic({ name: name.toLowerCase() , ...(description.length ? { description } : {})});
      wordApi(name).then(
        res => {
          const { results } = res;
          const synonyms = [];
          if (!results || !results.length) {
            newTopic.active = false;
            return done(null, newTopic, synonyms);
          }
          newTopic.active = true;
          results.map(def => def.synonyms.map(syn => synonyms.push(syn)));
          return done(null, newTopic, synonyms);
        },
        err => {
          newTopic.active = false;
          console.log('Network error checking for synonyms', err);
          return done(null, newTopic, []);
        }
      );
    };

    const collectSynonyms = (topic, synonyms, done) => {
      if (!synonyms || !synonyms.length) {
        return done(null, topic, []);
      }
      const similar = [];
      const processSimilar = (name, cb) => Topic.findOne({ name }).exec().then(
        res => {
          if (!res) {
            return cb();
          }
          similar.push(res._id);
          cb();
        },
        err => cb({
          status: 501,
          message: 'Server error processing similar entries to this topic',
          data: err
        })
      );
      async.each(synonyms, processSimilar, err => {
        if (err) {
          return done(err);
        }
        topic.similar = similar;
        done(null, topic, similar);
      });
    };

    const saveTopic = (topic, similars, done) => {
      topic.save((err, savedTopic) => {
        if (err) {
          return done({
            status: 501,
            message: 'Server error saving new topic. Please try again later.',
            data: err
          });
        }
        return done(null, savedTopic, similars);
      })
    }

    const updateSimilars = (topic, similars, done) => {
      if (!similars || !similars.length) {
        return done(null, topic);
      }
      const updateSimilar = (_id, cb) => Topic.findByIdAndUpdate(_id,
        { $push: { 'similar': topic._id }},
        { new: true, safe: true, upsert: true },
        (err, updated) => {
          if (err) {
            return cb({
              status: 501,
              message: 'Your topic has been saved, but we could not update those terms that are similar.',
              data: err
            });
          }
          cb();
        });
      async.each(similars, updateSimilar, err => {
        if (err) {
          return done(err);
        }
        return done(null, topic)
      })
    };

    async.waterfall([validate, collectSynonyms, saveTopic, updateSimilars], (err, topic) => {
      if (err && typeof err === 'object' && has(err, ['message', 'status', 'data'])) {
        return handleErr(res, err.status, err.message, err.data);
      }
      if (err) {
        return handleErr(res, 500);
      }
      res.json(topic);
    })
  },
  remove: (req, res) => {
    const { id } = req.params;
    if (!id) {
      return handleErr(res, 400, 'Please try your request again. Missing :id property', false);
    }
    Topic.findByIdAndRemove(id, (err, response) => {
      if (err) {
        return handleErr(res, 500);
      }
      res.json(response);
    })
  }
}
