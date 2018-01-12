'use strict';


const _ = require('lodash');
const helpers = require('./helpers');
const indicatorExtractor = require('./indicator');

function extractBidder(bidderAttrs, tenderAttrs = {}) {
  return {
    id: bidderAttrs.id,
    name: bidderAttrs.name,
    normalizedName: bidderAttrs.name.normalize('NFD').replace(/[\u0300-\u036f]/g, ''),
    address: bidderAttrs.address,
    isPublic: bidderAttrs.isPublic,
    xDigiwhistLastModified: helpers.formatTimestamp(bidderAttrs.modified),
    indicators: _
      .filter((tenderAttrs.indicators || []), { relatedEntityId: bidderAttrs.id })
      .map((indicatorAttrs) => indicatorExtractor.extractIndicator(indicatorAttrs)),
  };
}

function extractParticipates(bidderAttrs) {
  return {
    isLeader: bidderAttrs.isLeader || false,
  };
}

module.exports = {
  extractBidder,
  extractParticipates,
};
