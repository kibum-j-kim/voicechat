# Frontend
cd frontend
npm install  # Install dependencies
npm run dev  # Start the frontend development server

# Backend

### Windows
cd backend
python -m venv venv  # Create a virtual environment
venv\Scripts\activate  # Activate virtual environment
pip install -r requirements.txt  # Install dependencies
uvicorn main2:app --reload  # Start the backend server

### MacBook
cd backend
python3 -m venv venv  # Create a virtual environment
source venv/bin/activate  # Activate virtual environment
pip install -r requirements.txt  # Install dependencies
uvicorn main2:app --reload  # Start the backend server

pip install uvicorn
