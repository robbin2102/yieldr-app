# Verify Recent Events in MongoDB

## Events Found
- **Order 4008674** - OPEN - wallet `0x780bb763e1463d2236fec780b7bd6adb40aaa120`
- **Order 4008652** - OPEN - wallet `0x780bb763e1463d2236fec780b7bd6adb40aaa120`
- **Order 4008696** - OPEN - wallet `0x8e1c4e0a7e85b2490f6d811824515d6fad3115a6`

## MongoDB Queries

### 1. Check if all 3 orders were saved
```javascript
db.historicaltrades.find({
  orderId: { $in: [4008674, 4008652, 4008696] }
}).pretty()
```

### 2. Check details for each order individually

#### Order 4008674 (Test wallet)
```javascript
db.historicaltrades.findOne({ orderId: 4008674 })
```

#### Order 4008652 (Test wallet)
```javascript
db.historicaltrades.findOne({ orderId: 4008652 })
```

#### Order 4008696 (Manager wallet)
```javascript
db.historicaltrades.findOne({ orderId: 4008696 })
```

### 3. Verify all details are populated correctly
```javascript
db.historicaltrades.find({
  orderId: { $in: [4008674, 4008652, 4008696] }
}, {
  orderId: 1,
  eventType: 1,
  trader: 1,
  asset: 1,
  direction: 1,
  positionSizeUSDC: 1,
  leverage: 1,
  price: 1,
  timestamp: 1,
  blockNumber: 1,
  tradeIndex: 1,
  _id: 0
}).pretty()
```

### 4. Check latest events from test wallet
```javascript
db.historicaltrades.find({
  trader: "0x780bb763e1463d2236fec780b7bd6adb40aaa120"
}).sort({ timestamp: -1 }).limit(5).pretty()
```

### 5. Check latest events from manager wallet
```javascript
db.historicaltrades.find({
  trader: "0x8e1c4e0a7e85b2490f6d811824515d6fad3115a6"
}).sort({ timestamp: -1 }).limit(5).pretty()
```

### 6. Count total events per wallet
```javascript
db.historicaltrades.aggregate([
  {
    $match: {
      trader: { $in: [
        "0x780bb763e1463d2236fec780b7bd6adb40aaa120",
        "0x8e1c4e0a7e85b2490f6d811824515d6fad3115a6"
      ]}
    }
  },
  {
    $group: {
      _id: "$trader",
      totalEvents: { $sum: 1 },
      openEvents: {
        $sum: { $cond: [{ $eq: ["$eventType", "OPEN"] }, 1, 0] }
      },
      closeEvents: {
        $sum: { $cond: [{ $eq: ["$eventType", "CLOSE"] }, 1, 0] }
      }
    }
  }
])
```

### 7. Verify timestamps are recent (last 10 minutes)
```javascript
db.historicaltrades.find({
  orderId: { $in: [4008674, 4008652, 4008696] },
  timestamp: { $gte: new Date(Date.now() - 10 * 60 * 1000) }
}).count()
```
Should return `3` if all events are from last 10 minutes.

### 8. Check for duplicates (should be 0)
```javascript
db.historicaltrades.aggregate([
  {
    $match: {
      orderId: { $in: [4008674, 4008652, 4008696] }
    }
  },
  {
    $group: {
      _id: "$orderId",
      count: { $sum: 1 }
    }
  },
  {
    $match: {
      count: { $gt: 1 }
    }
  }
])
```
Should return empty array (no duplicates).

### 9. Verify all required fields are populated
```javascript
db.historicaltrades.find({
  orderId: { $in: [4008674, 4008652, 4008696] }
}).forEach(doc => {
  const missing = [];

  if (!doc.orderId) missing.push('orderId');
  if (!doc.eventType) missing.push('eventType');
  if (!doc.trader) missing.push('trader');
  if (!doc.asset) missing.push('asset');
  if (!doc.direction) missing.push('direction');
  if (!doc.positionSizeUSDC) missing.push('positionSizeUSDC');
  if (!doc.leverage) missing.push('leverage');
  if (!doc.price) missing.push('price');
  if (!doc.timestamp) missing.push('timestamp');
  if (!doc.blockNumber) missing.push('blockNumber');

  print(`Order ${doc.orderId}: ${missing.length === 0 ? '✅ All fields present' : '❌ Missing: ' + missing.join(', ')}`);
});
```
