const Book = require('./book-model');
const Topic = require('../topic/topic-model');
const Author = require('../author/author-model');
const { getUnique, thirdParty, handleErr, returnObjectsArray, downloadImg, searchGoogleBooks, processGBook } = require('../util/helpers');
const sendEmail = require('../util/sendEmail');
const { waterfall, each } = require('async');
const { has, omit, flatten } = require('lodash');
const scrapeIt = require('scrape-it');
const Fs = require('fs');
const Path = require('path');
const cloudinary = require('cloudinary');
const base64Img = require('base64-img');


cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API,
  api_secret: process.env.CLOUDINARY_SECRET
});

const processEnd = res => (err, data) => {
  if (typeof err === 'boolean' && err) {
    return;
  }
  if (err && typeof err === 'object' && has(err, ['data', 'status', 'message'])) {
    console.log('One error occured', err)
    return handleErr(res, err.status, err.message, err.data);
  }
  if (err) {
    console.log('An error occured', err);
    return handleErr(res, 500, 'An error occured', err);
  }
  console.log('sending data to client', data);
  res.json(data);
};

module.exports = {
  createFromGoogle: (req, res) => {
    const bookPayload = omit(req.body, ['created', 'likes', 'authors', 'topics', 'pictures', 'active', 'comments', 'reports', 'views', '_id']);
    const { authors: scribes = [], topics: cats = [], pictures: pix = []} = req.body;
    const authors = scribes.map(person => person.name);
    const categories = flatten(cats.map(topic => topic.topic.name));
    const imageLinks = {
      thumbnail: pix.length ? pix[0].link : undefined
    }
    const validate = done => {
      const { gId, gTag, title } = bookPayload
      const requiredFields = { gId, gTag, title };
      if (Object.keys(requiredFields).filter(key => !requiredFields[key]).length) {
        return done({
          status: 400,
          message: 'Required fields are missing',
          data: false
        });
      }
      console.log('Finished validating body');
      Book.findOne({ gId }).exec().then(
        book => {
          if (book) {
            res.json(book);
            return done(true);
            
          }
          done(null);
        },
        err => done(null)
      )
    };
    
    const getThirdPartyData = done => {
      const { isbn10 = undefined, isbn13 = undefined } = bookPayload;
      if (!isbn10 && !isbn13) {
        return done(null, { status: 400 });
      }
      const providers = ['goodReads', 'openLibary'];
      const thirdPartyData = { providers, status: 200 };
      const dataFetchMap = {
        goodReads: thirdParty.getGoodReadsData,
        openLibary: thirdParty.openLibraryData
      }
      const processProvider = (provider, callback) => {
        console.log('processing ' + provider);
        return dataFetchMap[provider](isbn10 || isbn13).then(
          res => {
            // const { data = undefined } = res;
            thirdPartyData[provider] = res.data;
            console.log(`${provider} - success: `, res.data);
            return callback();
          },
          err => {
      
            return callback(err);
          }
        )
      }

      return each(providers, processProvider, err => {
        if (err) {
          console.log(err);
          return done(null, { ...thirdPartyData, status: 500 });
        }
        console.log('got third party data', thirdPartyData);
        return done(null, thirdPartyData);
      });
    }

    const processAuthor = (thirdPartyData, done) => {
      console.log('Processing authors', authors)
      let queryAuthors = [...authors]
      if (thirdPartyData['openLibary']) {
        const { authors: olAuthors = [] } = thirdPartyData['openLibary'] || {};
        queryAuthors = queryAuthors.concat(olAuthors.map(auth => auth.name || ''));
      }
      if (!authors.length) {
        return done(null, [], thirdPartyData);
      }
      Author.find({ name: { $in: queryAuthors }}).exec().then(
        writers => {
          if (writers.length) {
            return done(null, writers, thirdPartyData);
          }
          const newAuthors = [];
          const createNewAuthor = (name, cb) => {
            console.log('creating new author: ' + name);
            const newAuthor = new Author({ name });
            newAuthor.save((err, createdAuthor) => {
              if (err) {
                cb({
                  status: 501,
                  message: 'Error creating new author for this book',
                  data: err
                });
                return;
              }
              newAuthors.push(createdAuthor);
              cb();
            })
          }
          each(authors, createNewAuthor, (err) => {
            if (err) {
              console.log('could not process authors', err)
              return done(err);
            }
            console.log('Successfully processed authors')
            return done(null, newAuthors, thirdPartyData);
          })
        },
        err => done({
          status: 500,
          message: 'Server error processing authors for this book',
          data: err
        })
      )
    };

    const processTopics = (writers, thirdPartyData, done) => {
      console.log('Processing topics', categories);
      let allTopics = [...categories];
      if (thirdPartyData['openLibary']) {
        const { subjects = [] } = thirdPartyData['openLibary'] || {};
        allTopics = allTopics.concat(subjects.map(s => s.name))
      }
      if (!allTopics.length) {
        console.log('there are no topics to add')
        return done(null, [], writers, thirdPartyData);
      }
      Topic.find({ name: { $in: allTopics }}).exec().then(
        topics => {
          console.log('finished searching for topics.')
          if (topics.length === allTopics.length) {
            console.log(`there are ${topics.length} that match, here is the first.`, topics[0])
            return done(null, topics, writers, thirdPartyData);
          }
          const foundTopics = topics.map(top => top.name);
          const newTopics = allTopics.filter(tp => foundTopics.includes(tp));
          const createNewTopic = (name, cb) => {
            console.log('Creating new topic: ' + name);
            const newTopic = new Topic({ name, active: true });
            newTopic.save((err, savedTopic) => {

              if (err) {
                cb({
                  status: 501,
                  message: 'Error creating new topics for this book.',
                  data: err
                });
                return;
              }
              newTopics.push(savedTopic);
              cb();
            })
          }
          each(allTopics.filter(tp => !foundTopics.includes(tp)), createNewTopic, err => {
            if (err) {
              return done(err);
            }
            console.log('successfully processed topics', newTopics)
            done(null, newTopics, writers, thirdPartyData);
          })
        },
        err => done({
          status: 501,
          message: 'Server error processing topics for this book.',
          data: err
        })
      )
    }

    const processImages = (topics, writers, thirdPartyData, done) => {
      console.log('saving images')
      const { thumbnail = undefined , smallThumbnail = undefined } = imageLinks;
      if (!thumbnail && !smallThumbnail) {
        console.log('NO images to save.')
        return done(null, false, topics, writers, thirdPartyData);
      }
      console.log('got images to save.', thumbnail || smallThumbnail);
      cloudinary.uploader.upload(thumbnail || smallThumbnail, (result) => {
        if (result.error) {
          console.log('cloudinary error', result.error);
          return done(null, false, topics, writers, thirdPartyData);
        }
        const image = {
          link: result.secure_url,
          public_id:result.public_id
        };
        console.log('Successfully processed images', image);
        return done(null, image, topics, writers, thirdPartyData);
      })
    }
    const processBook = (image, topics, writers, thirdPartyData, done) => {
      console.log('processing book. here are topics', topics[0])
      const newBook = new Book({
        ...bookPayload,
        authors: writers.map(writer => writer._id),
        active: true,
        topics: topics.map(topic => ({
          topic: topic._id,
          agreed: []
        })),
        thirdPartyData: Object.keys(omit(thirdPartyData, ['providers', 'status'])).reduce((x, y) => [...x, { provider: y, data: thirdPartyData[y]}], [])
      });
      if (image) {
        newBook.pictures = [ image ];
      }
      newBook.save((err, savedBook) => {
        if (err) {
          console.log('could not save book.', err);
          return done({
            status: 501,
            message: 'Server error saving this book',
            data: err
          });
        }
        console.log('successfully saved book')

        Book.populate(savedBook,[{
          path: 'authors'
        }, {
          path: 'topics.topic'
        }], (error, populatedBook) => {
          if (error) {
            console.log('could not populate book')
            return done(null, savedBook);
          }
          console.log('populated book')
          return done(null, populatedBook);
        })
      });
    }

    waterfall([validate, getThirdPartyData, processAuthor, processTopics, processImages, processBook], processEnd(res));
  },
  add: (req, res) => {
    const { title, writer, topics, isbn, amazon_link } = req.body;
    const author = writer;
    const { _id: person } = req.user;
    const validate = done => {
      console.log('validating', { title, author, topics, isbn, amazon_link })
      const errors = Object.keys({ title, writer, topics, isbn, amazon_link }).reduce((acc, curr) => [
        ...acc,
        ...(!req.body[curr] ? [curr] : [])
      ], []);
      if (errors.length) {
        return done({
          status: 400,
          message: `Please check the following fields: ${errors.map(x => x.charAt(0).toUpperCase() + x.slice(1)).join(', ')}`,
          data: errors
        })
      }
      return done(null);
    }

    const processAuthor = done => {
      const { id, name } = author;
      if (id && id.length) {
        return done(null, id);
      }
      const newAuthor = new Author({ name });
      newAuthor.save((err, writer) => {
        if (err) {
          return done({
            status: 501,
            message: 'Server error saving new author.',
            data: err
          });
        }
        return done(null, writer._id);
      })
    }

    const checkBook = (writer, done) => Book.findOne({ $or: [{ amazon_link: amazon_link.toLowerCase()}, { isbn }] }).exec().then(
      book => {
        if (!book) {
          return done(null, writer);
        }
        return done({
          status: 400,
          message: 'A book already exists on Keen Pages with this ISBN.',
          data: book
        })
      },
      err => done({
        status: 503,
        message: 'Server error verifying if this book already exists.',
        data: err
      })
    )
    const getData = (writer, done) => {
      scrapeIt(amazon_link, {
        pictureLink: {
          selector: '#imageBlockContainer img',
          attr: 'src'
        },
        ebookPictureLink: {
          selector: '#ebooks-img-canvas img',
          attr: 'src'
        },
        backupImg1: {
          selector: '#mainImageContainer img',
          attr: 'src'
        },
        amazonTitle: '#productTitle',
        amazonBackupTitle: '#ebooksProductTitle',
        ebookTitle: '#ebooksProductTitle',
        topics: {
          listItem: '.zg_hrsr_item',
          data: {
            topic: '.zg_hrsr_ladder a'
          }
        }
      }).then(
        ({ data, response, $, body }) => {
          console.log('finished running scrapeIt', { data });
          const { pictureLink, amazonTitle, ebookPictureLink, ebookTitle, backupImg1 } = data;
          if ((!pictureLink && !ebookPictureLink) || (!amazonTitle && !ebookTitle)) {
            return done({
              message: 'Please check the amazon link you pasted.',
              status: 400,
              err: amazon_link
            })
          }
          const fileName = `${Date.now()}${title.trim()}`
          const path = Path.resolve(__dirname, 'files', fileName);
          const picLink = pictureLink || ebookPictureLink;
          const description = amazonTitle || ebookTitle;
          if (!pictureLink && ebookPictureLink) {
            return done(null, {
              remove: false,
              path, filePath: picLink, fileName,
              amazonTitle: description,
            }, writer)
          }
          base64Img.img(picLink, path, fileName, (err, filePath) => {
            console.log('finished running base64 library', { filePath, err });
            if (err) {
              return done({
                message: 'Error saving picture for this book on media server',
                status: 501,
                data: err
              });
            }
            return done(null, {
              remove: true,
              filePath, path, fileName, amazonTitle: description
            }, writer);
          })
        },
        (err) => {
          return done({
            message: 'Link error. Please check your pasted amazon link.',
            status: 400,
            data: err
          })
        }
      )
    }
    const uploadToCloudinary = ({ filePath, remove, amazonTitle }, writer, done) => {
      cloudinary.uploader.upload(filePath, (result) => {
        if (result.error) {
          console.log('cloudinary error', result.error)
          return done({
            message: 'Error saving picture for this book on media server.',
            status: 501,
            data: result.error
          });
        }
        if (remove) {
          Fs.unlink(filePath, err => {
            if (err) {
              return done(null, { pictureResult: result, amazonTitle }, writer);
            }
          });
        }
        console.log('finished uploading file', result);
        return done(null, { pictureResult: result, amazonTitle }, writer)
      })
    };

    const processBook = ({ pictureResult, amazonTitle }, writer, done) => {
      const picture = {
        default: true,
        link: pictureResult.secure_url,
        plublic_id: pictureResult.public_id
      };
      console.log('picture details: ', picture)
      const newBook = new Book({
        title,
        author: writer,
        description: amazonTitle,
        topics: topics.map(topic => ({ topic: topic._id, agreed: [person] })),
        isbn: isbn.toLowerCase(),
        amazon_link: amazon_link.toLowerCase(),
        pictures: [picture],
        createdBy: req.user._id,
        
      });

      newBook.save((err, book) => {
        if (err) {
          return done({
            status: 501,
            message: 'Server error saving new book.',
            data: err
          });
        }
        Book.populate(book,
          [{ path: 'author'},
            { path: 'topics.topic'}
          ],
          (error, populatedBook) => {
            if (error) {
              return done(null, book)
            }
            return done(null, populatedBook)
          })
      })
    }

    const notify = (book, done) => sendEmail.bookAdded({ book, user: req.user }).then(
      () => done(null, book),
      () => done(null, book)
    )

    waterfall([
      validate,
      processAuthor,
      checkBook,
      getData,
      uploadToCloudinary,
      processBook,
      notify],
      processEnd(res));
  },
  getOne: (req, res) => {
    const { id } = req.params;
    if (!id) {
      return handleErr(res, 401, 'Please try your request again.');
    }
    Book.findById(id).exec().then(
      book => {
        if (!book) {
          return handleErr(res, 404, 'Book not found', book);
        }
        book.views = book.views + 1;
        book.save((err, updated) => {
          if (err) {
            return res.json(book);
          }
          res.json(book);
        });
      },
      err => handleErr(res, 501, 'Server error finding your book.', err)
    );
  },
  getByAuthor: (req, res) => {
    Book.find({ author: req.params.id }).exec().then(
      books => res.json(returnObjectsArray(books)),
      err => handleErr(res, 500, 'Server error retrieving books for this author.', err)
    )
  },
  query: (req, res) => {
    const { sort = '', topics = undefined, already = []} = req.body;
    if (!sort && (!topics || !topics.length)) {
      return handleErr(res, 400, 'No sort or topics included, try the getAll endpoint instead.', { sort, topics, already });
    }

    const query = Book.aggregate()
      .match({
        'topics': { topic: { $in: topics }},
        'gId': { $nin: already }
      })
      .project({
        'title': 1,
        'author': 1,
        'views': 1,
        'pictures': 1,
        'affiliate_link': 1,
        'amazon_link': 1,
        'description': 1,
        'topics': 1,
        'topicsLength': { '$size': { '$ifNull': ['$topics', []]} },
        'isbn': 1,
        'likes': 1,
        'likesLength': { '$size': { '$ifNull': ['$likes', []]} },
        'created': 1,
        'createdBy': 1
      })
      .unwind('$topics')
      .lookup({
        from: 'Author',
        localField: 'author',
        foreignField: '_id',
        as: 'author1'
      })
      .lookup({
        from: 'Topic',
        localField: 'topics.topic',
        foreignField: '_id',
        as: 'topicDocs'
      })
      .group({
        '_id': '$_id',
        'topics': { '$push': '$topics' }
      })
      .sort(sort)
      .limit(50)
      
      query.exec().then(
        books => res.json(returnObjectsArray(books)),
        err => handleErr(res, 500, 'Error retrieving your books', err)
      )
  },
  getByTopic: (req, res) => {
    // search books by topic
    const { topicId } = req.params;
    const validateRequest = done => {
      if (!topicId) {
        return done({
          status: 401,
          message: 'Missing a topic, please try your search again.',
          data: false
        })
      }
      done(null);
    }
    const getSimilarTopics = done => Topic.findById(topicId).exec().then(
      topic => {
        if (!topic) {
          return done({
            status: 404,
            message: 'Could not find this topic.',
            data: false
          })
        };
        const { similar } = topic;
        done(null, Array.from(new Set(similar, topicId)));
      },
      data => done({
        status: 501,
        message: 'Server error searching for topic details.',
        data
      })
    );

    const getMainBooks = (similar, done) => {
      Book.find({ 'topics': { topic: { $in: similar }}}).exec().then(
        books => {
          if (!books || !books.length) {
            return done({
              status: 404,
              message: 'There are no books for your topic.',
              data: false
            })
          };
          const results = books.reduce((acc, curr) => {
            const sorted = curr.topics.map(topic => topic.topic).includes(topicId) ? 'main' : 'similar';
            return {
              ...acc,
              [sorted]: [ ...acc[sorted], curr ]
            }
          }, {});
          return done(null, results);
        },
        data => done({
          status: 501,
          message: 'Server error getting your results. Please try again later.',
          data
        })
      )
    }

    waterfall([validateRequest, getSimilarTopics, getMainBooks], processEnd(res));
  },
  getAll: (req, res) => {
    Book.find().limit(50).exec().then(
      books => res.json(returnObjectsArray(books)),
      err => handleErr(res, 501, 'Server error retrieving your books', err)
    )
  },
  edit: (req, res) => {
    const { id } = req.params;
    if (!id) {
      return handleErr(res, 401, 'Please try your request again. Missing parameter (:id)');
    }
    Book.findByIdAndUpdate(id,
      { $set: req.body },
      { safe: true, new: true, upsert: true },
      (err, response) => {
        if (err) {
          return handleErr(res, 501, 'Server error updating this book.', err);
        }
        res.json(response);
      })
  },
  remove: (req, res) => {
    const { id } = req.params;
    if (!id) {
      return handleErr(res, 400, 'Request missing :id property', false);
    }
    Book.findByIdAndRemove(id, (err, response) => {
      if (err) {
        return handleErr(res, 500, '', err);
      }
      res.json(response);
    });
  },
  search: (req, res) => {
    const { text: word } = req.query;
    if (!word) {
      return handleErr(res, 400, 'You must type something in to perform a search.', false);
    }
    const text = decodeURI(word);
    const hit = new RegExp("^" + text, "i")
    const keenQuery = Book.find({ $or: [{ title: hit }, { description: hit }] });
    
    const searchGoogle = done => searchGoogleBooks(text).then(
      response => {
        const { data: { items } = { items: []} } = response;
        if (!items.length) {
          return done(null, []);
        }
        const processedBooks = items.map(processGBook);
        return done(null, processedBooks);
      },
      err => done({
        status: 501,
        message: 'Server error searching your books',
        data: err
      })
    )

    const searchKeen = (gBooks, done) => {
      keenQuery.lean().exec().then(
        books => {
          if (!books.length) {
            return done(null, gBooks);
          }
          const ids = books.map(book => book.gId);
          const allBooks = [ ...books, ...gBooks.filter(book => !ids.includes(book.gId))];
          return done(null, allBooks);
        },
        err => gBooks.length ? done(null, gBooks) : done({
          status: 500,
          message: 'Server error fetching your books.',
          data: err
        })
      )
    }
    
    waterfall([searchGoogle, searchKeen], (err, books) => {
      if (err && typeof err === 'object' && has(err, ['data', 'status', 'message'])) {
        return handleErr(res, err.status, err.message, err.data);
      }
      if (err) {
        console.log('An error occured', err);
        return handleErr(res, 500, 'An error occured', err);
      }
      return res.json(returnObjectsArray(books));
    })
  },
  toggleLike: (req, res) => {
    const { user: { _id: user }, params: { id: book }} = req;
    if (!book) {
      return handleErr(res, 400, 'Your request is missing a book Id', false);
    }
    Book.findById(book).exec().then(
      book => {
        if (!book) {
          return handleErr(res, 404, 'Could not find the book to update.', book);
        }
        book.likes = book.likes.includes(user)
          ? book.likes.filter(x => x !== user)
          : book.likes.concat(user);
        
        book.save((err, response) => {
          if (err) {
            return handleErr(res, 500);
          }
          res.json(response)
        })
      },
      err => handleErr(res, 500)
    )
  },
  addPic: (req, res) => {
    const { params: { id }, body: { picture }} = req;
    Book.findByIdAndUpdate(id,
      { $push: { 'pictures': picture }},
      { new: true, upsert: true, safe: true },
      (err, response) => {
        if (err) {
          return handleErr(res, 500);
        }
        res.json(response);
      })
  },
  rmPic: (req, res) => {
    const { params: { id, pictureId }} = req;
    Book.findByIdAndUpdate(id,
      { $pull: { 'pictures': { _id: pictureId }}},
      { new: true, upsert: true, safe: true },
      (err, response) => {
        if (err) {
          return handleErr(res, 500);
        }
        res.json(response);
      });
  },
  addTopic: (req, res) => {
    const getTopics = done => Topic.find({ name: { $in: req.body.topics.map(topic => topic.name )}}).lean().exec().then(
      topics => {
        console.log('fetched topics to see if exists', topics)
        if (!topics || !topics.length) {
          return done(null, {
            existing: [],
            new: req.body.topics
          })
        }
        return done(null, req.body.topics.reduce((acc, curr, i, arr) => {
          const section = topics.map(top => top.name).includes(curr.name)
            ? 'existing'
            : 'new'
          return {
            ...acc,
            [section]: [ ...acc[section],
              section === 'existing'
                ? topics.find(top => top.name === curr.name)
                : curr]
          }
        }, {
          existing: [],
          new: []
        }));
      },
      err => done({ status: 501, message: 'could not add topics' })
    )
    const createNews = (organizedTopics, done) => {
      console.log('will be creating new ones', organizedTopics)
      if (!organizedTopics.new.length) {
        console.log('no new to create')
        return done(null, organizedTopics.existing);
      }
      const createTopic = ({ name, description }, cb) => {
        const newTopx = new Topic({ name, description });
        console.log('creating new topic', { name, description })
        newTopx.save((error, newOne) => {
          if (error) {
            console.log('Error creating', error)
            cb({ status: 501, message: 'Could not create this topic', data: error})
          }
          console.log('succeeded')
          organizedTopics.existing.push(newOne);
          cb();
        });
      }
      each(organizedTopics.new, createTopic, (err) => {
        console.log('finished creating', err)
        if (err) {
          return done({
            status: 501,
            message: 'Could not create and add topics.',
            data: err
          });
        }
        return done(null, organizedTopics.existing);
      })
    }

    const addToBook = (tops, done) => Book.findById(req.params.id).exec().then(
      book => {
        if (!book) {
          Promise.reject('Could not get book');
        }
        console.log('adding the topic to the book, got the book')
        const bookTopicIds = book.topics.map(topic => topic.topic);
        const finalTopicsToAdd = tops
          .map(topic => topic._id)
          .filter(topic => !bookTopicIds.includes(topic))
          .map(topic => ({ topic, agreed: [req.user._id] }));
        console.log('Finished filtering out which to add and which not to.')
        if (!finalTopicsToAdd.length) {
          res.json(book);
          return;
        }
        book.topics.push(...finalTopicsToAdd);
        book.save((err, updatedBook) => {
          if (err) {
            return done({
              status: 501,
              message: 'Could not update this book to add your topics.',
              data: err
            })
          }
          Book.populate(updatedBook, [{ path: 'topics.topic'}, { path: 'author'}], (error, populated) => {
            if (error) {
              return done(null,updatedBook)
            }
            console.log('Everything worked fine')
            return done(null, populated)
          })
        })
      },
      err => done({ status: 500, message: 'Server error adding topics to book', data: err})
    );

    waterfall([getTopics, createNews, addToBook], processEnd(res))
  },
  rmTopic: (req, res) => {
    Book.findByIdAndUpdate(req.params.id,
      { $pull: { 'topics': { '_id': req.params.topicId }}},
      { safe: true, upsert: true, new: true },
      (err, response) => {
        if (err) {
          return handleErr(res, 500);
        }
        res.json(response);
      });
  },
  toggleAgree: (req, res) => {
    const { user: { _id }, params: { id, topicId }} = req;
    console.log(`toggling user: ${_id} from topic: ${topicId}`)
    Book.findById(id).exec().then(
      book => {
        if (!book) {
          return handleErr(res, 404, 'Could not find the book.', false);
        }
        for (let i = 0; i < book.topics.length; i++) {
          if (book.topics[i]._id == topicId) {
            console.log('Found the topic')
            if (book.topics[i].agreed.includes(_id)) {
              book.topics[i].agreed.splice(book.topics[i].agreed.indexOf(_id, 1));
            } else {
              book.topics[i].agreed.push(_id)
            }

          }
        }
        book.save((error, response) => {
          if (error) {
            return handleErr(res, 'Could not update the topic in this book.', error);
          }
          Book.populate(response, [{ path: 'topics.topic'}, { path: 'author'}], (error, populated) => {
            if (error) {
              res.json(response);
              return;
            }
            res.json(populated);
          });
        })
      },
      err => handleErr(res, 500)
    )
  }
}
