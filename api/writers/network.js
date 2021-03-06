'use strict';

const _ = require('lodash');
const Promise = require('bluebird');
const uuidv4 = require('uuid/v4');
const moment = require('moment');

const codes = require('../helpers/codes');
const config = require('../../config/default');

function recordName(id, className) {
  return `${className.toLowerCase()}${id.replace(/-/g, '')}`;
}

async function createNetwork(networkParams, user) {
  const networkQuery = _.pickBy(networkParams.query, (val) => !(_.isUndefined(val)));
  if (_.isEmpty(networkQuery) === true) {
    throw codes.BadRequest('Network "query" can\'t be empty.');
  }

  const networkAttrs = Object.assign({}, networkParams);
  Object.assign(networkAttrs, {
    id: uuidv4(),
    query: networkQuery,
    created: moment().format('YYYY-MM-DD HH:mm:ss'),
    updated: moment().format('YYYY-MM-DD HH:mm:ss'),
  });

  const networkName = recordName(networkAttrs.id, 'Network');
  const transaction = config.db.let(networkName, (t) => {
    t.create('vertex', 'Network')
      .set(networkAttrs);
  });
  await createOwnsEdge(transaction, user, networkName);
  const networkActorsMapping = await Promise.join(
    createBuyerNodes(transaction, networkParams.settings, networkQuery, networkName),
    createBidderNodes(transaction, networkParams.settings, networkQuery, networkName),
    (buyerActorsMapping, bidderActorsMapping) =>
      Object.assign(buyerActorsMapping, bidderActorsMapping),
  );
  await Promise.all([
    createContractsEdges(transaction, networkParams.settings, networkQuery, networkActorsMapping),
    createPartnersEdges(transaction, 'Awards', networkQuery, networkActorsMapping),
    createPartnersEdges(transaction, 'Participates', networkQuery, networkActorsMapping),
  ]);

  return transaction.commit(2).return(`$${networkName}`).one();
}

function queryToBidFilters(networkQuery) {
  const filters = [];
  const actorFilters = [];
  if (networkQuery.buyers) {
    actorFilters.push("in('Awards').id in :buyers");
  }
  if (networkQuery.bidders) {
    actorFilters.push("in('Participates').id in :bidders");
  }
  if (actorFilters.length) {
    filters.push(`(${_.join(_.compact(actorFilters), ' OR ')})`);
  }

  if (networkQuery.countries) {
    filters.push('xCountry in :countries');
  }
  if (networkQuery.years) {
    filters.push('xYear in :years');
  }
  if (networkQuery.cpvs) {
    filters.push("out('AppliedTo').in('Comprises').out('HasCPV').code in :cpvs");
  }
  return filters;
}

function createOwnsEdge(transaction, user, networkName) {
  if (_.isUndefined(user) === false) {
    const userName = recordName(user.id, 'User');
    transaction.let(`${userName}Owns${networkName}`, (t) => {
      t.create('edge', 'Owns')
        .from(user['@rid'])
        .to(`$${networkName}`);
    });
    return userName;
  }
  return undefined;
}

function settingsToValueQuery(sizeSetting) {
  let value;
  if (sizeSetting === 'numberOfWinningBids') {
    value = 'set(id).size()';
  } else if (sizeSetting === 'amountOfMoneyExchanged') {
    value = 'sum(price.netAmountEur)';
  }
  return value;
}

function createBidderNodes(transaction, networkSettings, networkQuery, networkName) {
  const bidderActorMapping = {};
  const valueQuery = settingsToValueQuery(networkSettings.nodeSize);
  const bidderNodesQuery = `SELECT bidder.name as label,
    bidder[@rid] as bidderRID,
    ${valueQuery} as value,
    median(out('AppliedTo').bidsCount) as medianCompetition
    FROM (
      SELECT *, in('Participates') as bidder
      FROM Bid
      WHERE ${_.join(queryToBidFilters(networkQuery), ' AND ')}
      AND isWinning=true
      UNWIND bidder
    )
    WHERE bidder IS NOT NULL
    GROUP BY bidder;`;
  return config.db.query(bidderNodesQuery, { params: networkQuery })
    // I avoid using reduce here instead of map to run this in parralel
    .then((bidderNodes) => Promise.map(bidderNodes, (node) => {
      const nodeAttrs = _.pick(
        node,
        ['label', 'value', 'medianCompetition'],
      );
      nodeAttrs.type = 'bidder';
      nodeAttrs.active = true;
      nodeAttrs.id = uuidv4();
      const partnerName = createNetworkActor(transaction, nodeAttrs, node.bidderRID, networkName);
      bidderActorMapping[node.bidderRID] = partnerName;
      return undefined;
    }))
    .then(() => bidderActorMapping);
}

function createBuyerNodes(transaction, networkSettings, networkQuery, networkName) {
  const buyerActorMapping = {};
  const valueQuery = settingsToValueQuery(networkSettings.nodeSize);
  const buyerNodesQuery = `SELECT buyer.name as label,
    buyer[@rid] as buyerRID,
    ${valueQuery} as value,
    buyer.address.country as country,
    median(out('AppliedTo').bidsCount) as medianCompetition
    FROM (
      SELECT *, in('Awards') as buyer
      FROM Bid
      WHERE ${_.join(queryToBidFilters(networkQuery), ' AND ')}
      AND isWinning=true
      UNWIND buyer
    )
    WHERE buyer IS NOT NULL
    GROUP BY buyer;`;
  return config.db.query(buyerNodesQuery, { params: networkQuery })
    .then((buyerNodes) => Promise.map(buyerNodes, (node) => {
      const nodeAttrs = _.pick(
        node,
        ['label', 'value', 'medianCompetition', 'country'],
      );
      nodeAttrs.type = 'buyer';
      nodeAttrs.active = true;
      nodeAttrs.id = uuidv4();
      const partnerName = createNetworkActor(transaction, nodeAttrs, node.buyerRID, networkName);
      buyerActorMapping[node.buyerRID] = partnerName;
      return undefined;
    }))
    .then(() => buyerActorMapping);
}

function createNetworkActor(transaction, nodeAttrs, actorRID, networkName) {
  const partnerName = recordName(nodeAttrs.id, 'NetworkActor');
  transaction.let(partnerName, (t) => {
    t.create('vertex', 'NetworkActor')
      .set(nodeAttrs);
  });
  transaction.let(`${partnerName}PartOf`, (t) => {
    t.create('edge', 'PartOf')
      .from(`$${partnerName}`)
      .to(`$${networkName}`);
  });
  transaction.let(`ActingAs${partnerName}`, (t) => {
    t.create('edge', 'ActingAs')
      .from(actorRID)
      .to(`$${partnerName}`);
  });
  return partnerName;
}

function createContractsEdges(transaction, networkSettings, networkQuery, networkActorsMapping) {
  const valueQuery = settingsToValueQuery(networkSettings.edgeSize);
  const contractsEdgesQuery = `SELECT buyer[@rid] as buyerRID,
    bidder[@rid] as bidderRID,
    ${valueQuery} as value
    FROM (
      SELECT *, in('Participates') as bidder,
      in('Awards') as buyer
      FROM Bid
      WHERE ${_.join(queryToBidFilters(networkQuery), ' AND ')}
      AND isWinning=true
      UNWIND bidder, buyer
    )
    WHERE buyer IS NOT NULL
    AND bidder IS NOT NULL
    GROUP BY [buyer, bidder];`;
  return config.db.query(contractsEdgesQuery, { params: networkQuery })
    .then((contractsEdges) => Promise.map(contractsEdges, (edge) => {
      const edgeAttrs = {
        uuid: uuidv4(),
        value: edge.value,
        active: true,
      };
      const fromName = networkActorsMapping[edge.buyerRID];
      const toName = networkActorsMapping[edge.bidderRID];
      return createNetworkEdge(transaction, 'Contracts', edgeAttrs, fromName, toName);
    }));
}

function createPartnersEdges(transaction, edgeToBidClass, networkQuery, networkActorsMapping) {
  const partnersEdgesQuery = `SELECT actorRID,
    partnerRID,
    set(bidRID).size() as value
    FROM (
      SELECT bidRID,
      actorRID,
      partnerRID,
      set(actorRID, partnerRID) as pair
      FROM (
        SELECT @rid as bidRID,
        in('${edgeToBidClass}') as actorRID,
        in('${edgeToBidClass}') as partnerRID
        FROM Bid
        WHERE ${_.join(queryToBidFilters(networkQuery), ' AND ')}
        AND isWinning=true
        AND in('${edgeToBidClass}').size() > 1
        UNWIND actorRID, partnerRID
      ) WHERE actorRID != partnerRID
    ) GROUP BY pair;`;
  return config.db.query(partnersEdgesQuery, { params: networkQuery })
    .then((partnersEdges) => Promise.map(partnersEdges, (edge) => {
      const edgeAttrs = {
        uuid: uuidv4(),
        value: edge.value,
        active: true,
      };
      const fromName = networkActorsMapping[edge.actorRID];
      const toName = networkActorsMapping[edge.partnerRID];
      return createNetworkEdge(transaction, 'Partners', edgeAttrs, fromName, toName);
    }));
}

function createNetworkEdge(transaction, edgeClass, edgeAttrs, fromName, toName) {
  const edgeName = `${fromName}${edgeClass}${toName}`;
  transaction.let(edgeName, (t) => {
    t.create('edge', edgeClass)
      .from(`$${fromName}`)
      .to(`$${toName}`)
      .set(edgeAttrs);
  });
  return edgeName;
}

module.exports = {
  createNetwork,
  createBidderNodes,
  createBuyerNodes,
  createContractsEdges,
  createPartnersEdges,
  createOwnsEdge,
  createNetworkActor,
  createNetworkEdge,
  settingsToValueQuery,
  queryToBidFilters,
  recordName,
};
