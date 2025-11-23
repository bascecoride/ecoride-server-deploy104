export const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) *
      Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

export const calculateFare = async (distance) => {
  // Import FareRate model dynamically to avoid circular dependencies
  const FareRate = (await import('../models/FareRate.js')).default;
  
  // Fetch fare rates from database
  const fareRates = await FareRate.find();
  
  // Default rates as fallback
  const defaultRates = {
    "Single Motorcycle": { minimumRate: 15, perKmRate: 2.5 },
    "Tricycle": { minimumRate: 20, perKmRate: 2.8 },
    "Cab": { minimumRate: 30, perKmRate: 3 },
  };
  
  // Build rate structure from database or use defaults
  const rateStructure = {};
  
  if (fareRates.length > 0) {
    fareRates.forEach(rate => {
      rateStructure[rate.vehicleType] = {
        minimumRate: rate.minimumRate,
        perKmRate: rate.perKmRate
      };
    });
  } else {
    // Use default rates if no rates in database
    Object.assign(rateStructure, defaultRates);
  }

  const fareCalculation = (minimumRate, perKmRate) => {
    const calculatedFare = distance * perKmRate;
    return Math.max(calculatedFare, minimumRate);
  };

  const result = {};
  
  // Calculate fare for each vehicle type
  for (const vehicleType in rateStructure) {
    result[vehicleType] = fareCalculation(
      rateStructure[vehicleType].minimumRate,
      rateStructure[vehicleType].perKmRate
    );
  }
  
  return result;
};

export const generateOTP = () => {
  return Math.floor(1000 + Math.random() * 9000).toString();
};
