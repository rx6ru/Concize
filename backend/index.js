const dotenv = require("dotenv").config();
const express = require("express");
const cors = require("cors");

// const authRoutes = require("./routes/authRoutes");
// const meetingRoutes = require("./routes/meetingRoutes");
const audioRoutes = require("./routes/audioRoutes");

const app = express();

app.use(cors());
app.use(express.json());


// app.use("/api/auth", authRoutes);
// app.use("/api/meetings", meetingRoutes);
app.use("/api/audios", audioRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});