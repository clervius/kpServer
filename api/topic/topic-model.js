const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const topicSchema = new Schema({
  name: {
    type: String,
    required: true
  },
  description: String,
  active: {
    type: Boolean,
    default: false
  },
  similar: [{
    type: Schema.Types.ObjectId,
    ref: 'Topic'
  }]
});

module.exports = mongoose.model('Topic', topicSchema);
